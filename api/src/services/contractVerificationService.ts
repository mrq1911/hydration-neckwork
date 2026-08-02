import { randomUUID } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { fetchDeployedBytecode, verifyStandardJson, type MatchType } from './verifierClient.ts'

// Contract verification: owns the job lifecycle and the three ClickHouse tables
// in `005_contracts.sql`. Protocol-agnostic on purpose — the Sourcify routes and
// (later) the Etherscan routes are both thin translations over this.
//
// Sourcify's model is a job ticket: submit returns an id immediately and the
// client polls. We honour that rather than compiling inside the request, because
// a large project can take longer than a client is willing to hold a connection.

let client: ClickHouseClient

export function initContractVerificationService(c: ClickHouseClient) {
  client = c
}

// Sourcify V2's match vocabulary. `exact_match` is a metadata-exact match,
// `match` is a match with differing metadata (what Blockscout calls PARTIAL),
// and `null` means not verified at all.
export type MatchLevel = 'exact_match' | 'match' | null

export function toMatchLevel(matchType: MatchType | '' | undefined): MatchLevel {
  if (matchType === 'FULL') return 'exact_match'
  if (matchType === 'PARTIAL') return 'match'
  return null
}

export type JobState = {
  verificationId: string
  address: string
  chainId: string
  status: 'pending' | 'verified' | 'failed'
  matchType: MatchType | ''
  contractIdentifier: string
  compilerVersion: string
  errorCode: string
  errorMessage: string
  // Cached at submit time so the read paths never call eth_getCode. Carried on
  // every write: `contract_verifications` is a ReplacingMergeTree keyed by
  // verification_id, so a later row that omitted this column would win and
  // silently blank it.
  deployedBytecode: string
  submittedAt: Date
  completedAt: Date | null
}

// In-process view of jobs. Every transition is also written to ClickHouse, so a
// poll that arrives after a redeploy still resolves (see `getJob`) instead of
// telling the client its verification vanished.
const jobs = new Map<string, JobState>()

export function normalizeAddressParam(address: string): string {
  return address.trim().toLowerCase()
}

export function isH160(address: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(address)
}

// --- lookups -------------------------------------------------------------

export type VerifiedContract = {
  address: string
  matchType: MatchType
  contractName: string
  compilerVersion: string
  abi: string
}

export async function getVerifiedContract(address: string): Promise<VerifiedContract | null> {
  const rows = await client
    .query({
      query: `
        SELECT a.address AS address, a.abi AS abi, a.contract_name AS contract_name,
               argMax(s.match_type, s.updated_at) AS match_type,
               argMax(s.compiler_version, s.updated_at) AS compiler_version
        FROM price_data.contract_abis AS a FINAL
        LEFT JOIN price_data.contract_sources AS s ON s.address = a.address
        WHERE a.address = {address:String} AND a.deleted = 0 AND a.source = 'verified'
        GROUP BY a.address, a.abi, a.contract_name
        LIMIT 1`,
      query_params: { address },
      format: 'JSONEachRow',
    })
    .then(r => r.json<{ address: string; abi: string; contract_name: string; match_type: string; compiler_version: string }>())

  const row = rows[0]
  if (!row) return null
  return {
    address: row.address,
    matchType: row.match_type === 'FULL' ? 'FULL' : 'PARTIAL',
    contractName: row.contract_name,
    compilerVersion: row.compiler_version,
    abi: row.abi,
  }
}

// --- submit --------------------------------------------------------------

export type SubmitInput = {
  address: string
  chainId: string
  compilerVersion: string
  contractIdentifier: string
  stdJsonInput: unknown
}

export type SubmitOutcome =
  | { ok: true; verificationId: string }
  | { ok: false; code: 'already_verified' | 'cannot_fetch_bytecode'; message: string }

export async function submitVerification(input: SubmitInput): Promise<SubmitOutcome> {
  const existing = await getVerifiedContract(input.address)
  if (existing) {
    return { ok: false, code: 'already_verified', message: `Contract ${input.address} is already verified` }
  }

  const bytecode = await fetchDeployedBytecode(input.address)
  if (!bytecode) {
    return {
      ok: false,
      code: 'cannot_fetch_bytecode',
      message: `No contract code found at ${input.address}`,
    }
  }

  const verificationId = randomUUID()
  const job: JobState = {
    verificationId,
    address: input.address,
    chainId: input.chainId,
    status: 'pending',
    matchType: '',
    contractIdentifier: input.contractIdentifier,
    compilerVersion: input.compilerVersion,
    errorCode: '',
    errorMessage: '',
    deployedBytecode: bytecode,
    submittedAt: new Date(),
    completedAt: null,
  }
  jobs.set(verificationId, job)
  await persistJob(job)

  // Fire and forget: the client polls. Any throw is captured onto the job so a
  // failure surfaces as a clean verification failure rather than a hung poll.
  void runVerification(job, input).catch(async err => {
    job.status = 'failed'
    job.errorCode = 'internal_error'
    job.errorMessage = err instanceof Error ? err.message : String(err)
    job.completedAt = new Date()
    await persistJob(job).catch(() => {})
  })

  return { ok: true, verificationId }
}

async function runVerification(job: JobState, input: SubmitInput): Promise<void> {
  const result = await verifyStandardJson({
    bytecode: job.deployedBytecode,
    compilerVersion: input.compilerVersion,
    stdJsonInput: input.stdJsonInput,
  })

  if (!result.ok) {
    job.status = 'failed'
    job.errorCode = result.code
    job.errorMessage = result.message
    job.completedAt = new Date()
    await persistJob(job)
    return
  }

  job.status = 'verified'
  job.matchType = result.matchType
  job.completedAt = new Date()
  await Promise.all([persistJob(job), persistVerified(job, result)])
}

async function persistJob(job: JobState): Promise<void> {
  await client.insert({
    table: 'price_data.contract_verifications',
    values: [
      {
        verification_id: job.verificationId,
        address: job.address,
        chain_id: job.chainId,
        status: job.status,
        match_type: job.matchType,
        contract_identifier: job.contractIdentifier,
        compiler_version: job.compilerVersion,
        error_code: job.errorCode,
        error_message: job.errorMessage,
        deployed_bytecode: job.deployedBytecode,
        submitted_at: toClickHouseDateTime(job.submittedAt),
        completed_at: job.completedAt ? toClickHouseDateTime(job.completedAt) : null,
      },
    ],
    format: 'JSONEachRow',
  })
}

async function persistVerified(
  job: JobState,
  result: Extract<Awaited<ReturnType<typeof verifyStandardJson>>, { ok: true }>,
): Promise<void> {
  const settings = parseSettings(result.compilerSettings)
  const files = Object.entries(result.sourceFiles)
  await Promise.all([
    client.insert({
      table: 'price_data.contract_abis',
      values: [
        {
          address: job.address,
          abi: result.abi,
          source: 'verified',
          contract_name: result.contractName,
        },
      ],
      format: 'JSONEachRow',
    }),
    files.length
      ? client.insert({
          table: 'price_data.contract_sources',
          values: files.map(([file_path, content]) => ({
            address: job.address,
            file_path,
            content,
            contract_name: result.contractName,
            compiler_version: result.compilerVersion,
            evm_version: settings.evmVersion,
            optimizer_enabled: settings.optimizerEnabled ? 1 : 0,
            optimizer_runs: settings.optimizerRuns,
            match_type: result.matchType,
            constructor_arguments: result.constructorArguments,
            compiler_settings: result.compilerSettings,
          })),
          format: 'JSONEachRow',
        })
      : Promise.resolve(),
  ])
}

export function parseSettings(raw: string): { evmVersion: string; optimizerEnabled: boolean; optimizerRuns: number } {
  try {
    const s = JSON.parse(raw) as { evmVersion?: unknown; optimizer?: { enabled?: unknown; runs?: unknown } }
    return {
      evmVersion: typeof s.evmVersion === 'string' ? s.evmVersion : '',
      optimizerEnabled: s.optimizer?.enabled === true,
      optimizerRuns: typeof s.optimizer?.runs === 'number' ? s.optimizer.runs : 0,
    }
  } catch {
    return { evmVersion: '', optimizerEnabled: false, optimizerRuns: 0 }
  }
}

// --- poll ----------------------------------------------------------------

export async function getJob(verificationId: string): Promise<JobState | null> {
  const inProcess = jobs.get(verificationId)
  if (inProcess) return inProcess

  const rows = await client
    .query({
      query: `
        SELECT verification_id, address, chain_id, status, match_type, contract_identifier,
               compiler_version, error_code, error_message, deployed_bytecode,
               toUnixTimestamp(submitted_at) AS submitted_ts,
               toUnixTimestamp(ifNull(completed_at, toDateTime(0))) AS completed_ts
        FROM price_data.contract_verifications FINAL
        WHERE verification_id = {id:String}
        LIMIT 1`,
      query_params: { id: verificationId },
      format: 'JSONEachRow',
    })
    .then(r =>
      r.json<{
        verification_id: string
        address: string
        chain_id: string
        status: string
        match_type: string
        contract_identifier: string
        compiler_version: string
        error_code: string
        error_message: string
        deployed_bytecode: string
        submitted_ts: number
        completed_ts: number
      }>(),
    )

  const row = rows[0]
  if (!row) return null
  return {
    verificationId: row.verification_id,
    address: row.address,
    chainId: row.chain_id,
    status: row.status === 'verified' ? 'verified' : row.status === 'failed' ? 'failed' : 'pending',
    matchType: row.match_type === 'FULL' ? 'FULL' : row.match_type === 'PARTIAL' ? 'PARTIAL' : '',
    contractIdentifier: row.contract_identifier,
    compilerVersion: row.compiler_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    deployedBytecode: row.deployed_bytecode,
    submittedAt: new Date(Number(row.submitted_ts) * 1000),
    // A pending job has no completion time; the query floors it to the epoch.
    completedAt: Number(row.completed_ts) > 0 ? new Date(Number(row.completed_ts) * 1000) : null,
  }
}

function toClickHouseDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// Test seam: the route tests drive job states without a ClickHouse round trip.
export function __setJobForTest(job: JobState) {
  jobs.set(job.verificationId, job)
}
export function __clearJobsForTest() {
  jobs.clear()
}
