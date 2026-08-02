import { describe, it, expect } from 'vitest'
import { collapseDuplicateSlashes, jobResponse, SOURCIFY_PREFIXES } from './verification.ts'
import { toMatchLevel, type JobState } from '../services/contractVerificationService.ts'

// These assertions encode wire rules observed by running forge 1.5.1 and
// hardhat-verify 3.x against a recording proxy. Each one, if broken, fails
// silently in a way that looks like a client bug rather than a server bug —
// hence the coverage.

function job(over: Partial<JobState> = {}): JobState {
  return {
    verificationId: 'job-1',
    address: '0x531a654d1696ed52e7275a8cede955e82620f99a',
    chainId: '222222',
    status: 'pending',
    matchType: '',
    contractIdentifier: 'src/Store.sol:Store',
    compilerVersion: '0.8.10+commit.fc410830',
    errorCode: '',
    errorMessage: '',
    deployedBytecode: '0x6080604052',
    submittedAt: new Date('2026-08-02T10:00:00Z'),
    completedAt: null,
    ...over,
  }
}

describe('toMatchLevel', () => {
  it('maps the verifier vocabulary onto Sourcify V2 levels', () => {
    // Sourcify renamed these: perfect -> exact_match, partial -> match.
    expect(toMatchLevel('FULL')).toBe('exact_match')
    expect(toMatchLevel('PARTIAL')).toBe('match')
    expect(toMatchLevel('')).toBeNull()
  })
})

describe('jobResponse', () => {
  it('always includes contract and jobStartTime', () => {
    // forge's deserializer treats `contract` as non-optional and hardhat's type
    // guard additionally requires `jobStartTime`. Omitting either turns a clean
    // failure into ~2 minutes of parse-error retries (forge) or an unretried
    // unexpected-response error (hardhat).
    for (const state of [job(), job({ status: 'verified', matchType: 'FULL', completedAt: new Date() })]) {
      const res = jobResponse(state)
      expect(res.contract).toBeDefined()
      expect(typeof res.jobStartTime).toBe('string')
      expect(res.verificationId).toBe('job-1')
    }
  })

  it('reports a pending job as not completed and with a null match', () => {
    const res = jobResponse(job())
    expect(res.isJobCompleted).toBe(false)
    expect(res.contract.match).toBeNull()
    expect('error' in res).toBe(false)
  })

  it('reports a full match as exact_match', () => {
    const res = jobResponse(job({ status: 'verified', matchType: 'FULL', completedAt: new Date('2026-08-02T10:00:05Z') }))
    expect(res.isJobCompleted).toBe(true)
    expect(res.contract.match).toBe('exact_match')
    expect(res.contract.runtimeMatch).toBe('exact_match')
    expect('error' in res).toBe(false)
  })

  it('reports a metadata-only mismatch as a successful partial match, not a failure', () => {
    // Foundry's `bytecode_hash = "none"` always lands here, so PARTIAL must not
    // be surfaced as a verification failure.
    const res = jobResponse(job({ status: 'verified', matchType: 'PARTIAL', completedAt: new Date() }))
    expect(res.contract.match).toBe('match')
    expect('error' in res).toBe(false)
  })

  it('never emits a completed job with a null match and no error', () => {
    // This exact combination is a silent false pass: forge exits 0 printing
    // nothing, and hardhat throws an unexpected-response error.
    const res = jobResponse(job({ status: 'failed', completedAt: new Date(), errorCode: 'no_match', errorMessage: 'bytecode mismatch' }))
    expect(res.isJobCompleted).toBe(true)
    expect(res.contract.match).toBeNull()
    expect(res.error).toBeDefined()
  })

  it('gives every error object customCode, message and errorId', () => {
    // hardhat's error type guard requires all three; without errorId it misses
    // the clean-failure branch entirely.
    const res = jobResponse(job({ status: 'failed', completedAt: new Date(), errorCode: 'no_match', errorMessage: 'nope' }))
    expect(res.error).toMatchObject({ customCode: 'no_match', message: 'nope' })
    expect(typeof res.error?.errorId).toBe('string')
    expect(res.error?.errorId.length).toBeGreaterThan(0)
  })

  it('falls back to a usable error code and message when the job carries neither', () => {
    const res = jobResponse(job({ status: 'failed', completedAt: new Date() }))
    expect(res.error?.customCode).toBe('no_match')
    expect(res.error?.message).toBeTruthy()
  })

  it('never claims a creation-input match, since only runtime bytecode is compared', () => {
    const res = jobResponse(job({ status: 'verified', matchType: 'FULL', completedAt: new Date() }))
    expect(res.contract.creationMatch).toBeNull()
  })
})

describe('collapseDuplicateSlashes', () => {
  it('collapses a doubled leading slash so //v2 routes as /v2', () => {
    // What a hardhat user gets once nginx strips `/api/` from `/api//v2/...`.
    expect(collapseDuplicateSlashes('//v2/verify/222222/0xabc')).toBe('/v2/verify/222222/0xabc')
  })
  it('leaves ordinary paths untouched', () => {
    expect(collapseDuplicateSlashes('/v2/contract/222222/0xabc')).toBe('/v2/contract/222222/0xabc')
    expect(collapseDuplicateSlashes('/explorer/counts')).toBe('/explorer/counts')
  })
  it('does not collapse an interior double slash', () => {
    // Only the leading segment is ambiguous; an interior `//` is a real path.
    expect(collapseDuplicateSlashes('/v2/verify//x')).toBe('/v2/verify//x')
  })
})

describe('SOURCIFY_PREFIXES', () => {
  it('covers every base-URL shape forge and hardhat can produce', () => {
    // forge appends `v2/...` with no separator; hardhat appends `/v2/...`. So a
    // base of `.../api` fuses into `/apiv2`, and `.../api/` yields `/api/v2`.
    expect(SOURCIFY_PREFIXES).toContain('/v2')
    expect(SOURCIFY_PREFIXES).toContain('/apiv2')
    expect(SOURCIFY_PREFIXES).toContain('/api/v2')
  })
})
