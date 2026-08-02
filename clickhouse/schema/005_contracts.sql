-- Contract verification state. Like `004_user.sql` this is NOT reproducible from
-- raw chain data — it is written only by the api service when someone verifies a
-- contract — but unlike 004 it is PUBLIC: verified sources and ABIs are meant to
-- be readable by every viewer, so these tables stay out of the private `user_*`
-- set and out of `TABLES=` in ops/backup-user-tables.sh. They still need their
-- own backup, for the same reason 004 does: a projection rebuild cannot
-- regenerate them.
--
-- Same upsert idiom as account_tags/user_*: ReplacingMergeTree keyed by the
-- thing being described, so re-verifying a contract replaces its row instead of
-- accumulating history.

-- Address → ABI. This is the table the log decoder reads, so `source` matters:
-- only 'verified' (bytecode actually matched) may be trusted to name event args,
-- because decoded address args become account_alias_directory rows. 'manual' is
-- operator-imported and deliberately excluded from alias emission.
CREATE TABLE IF NOT EXISTS price_data.contract_abis (address String, abi String CODEC(ZSTD(6)), source LowCardinality(String) DEFAULT 'verified', contract_name String DEFAULT '', deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY address SETTINGS index_granularity = 256;

-- One row per source file of a verified contract. `match_type` is FULL only when
-- the metadata/cbor-auxdata bytes matched too; PARTIAL is a successful
-- verification of a contract compiled with a different metadata hash (very
-- common — Foundry's `bytecode_hash = "none"` always lands here) and must not be
-- presented as a failure.
CREATE TABLE IF NOT EXISTS price_data.contract_sources (address String, file_path String, content String CODEC(ZSTD(6)), contract_name String DEFAULT '', compiler_version String DEFAULT '', evm_version String DEFAULT '', optimizer_enabled UInt8 DEFAULT 0, optimizer_runs UInt32 DEFAULT 0, match_type LowCardinality(String) DEFAULT '', constructor_arguments String DEFAULT '', compiler_settings String DEFAULT '' CODEC(ZSTD(6)), deleted UInt8 DEFAULT 0, created_at DateTime DEFAULT now(), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (address, file_path) SETTINGS index_granularity = 256;

-- Verification attempts, keyed by the opaque id handed back to the client. Both
-- verification protocols poll by this id, so it survives a restart: an api
-- redeploy mid-verification must not turn a client's poll into "job not found".
-- `deployed_bytecode` is cached here at submit time precisely so the read paths
-- (Sourcify lookup, Etherscan getabi/getsourcecode) never have to call
-- eth_getCode — AGENTS.md forbids per-request RPC on request paths.
CREATE TABLE IF NOT EXISTS price_data.contract_verifications (verification_id String, address String, chain_id String DEFAULT '', status LowCardinality(String) DEFAULT 'pending', match_type LowCardinality(String) DEFAULT '', contract_identifier String DEFAULT '', compiler_version String DEFAULT '', error_code LowCardinality(String) DEFAULT '', error_message String DEFAULT '', deployed_bytecode String DEFAULT '' CODEC(ZSTD(6)), submitted_at DateTime DEFAULT now(), completed_at Nullable(DateTime), updated_at DateTime64(3) DEFAULT now64(3)) ENGINE = ReplacingMergeTree(updated_at) ORDER BY verification_id SETTINGS index_granularity = 256;
