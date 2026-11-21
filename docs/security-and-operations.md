# Security Architecture & Operations Runbook

This guide explains the security invariants enforced by `bugzilla-mcp`, real-world operational quirks of self-hosted Bugzilla 5.0 / 5.2+, SQLite upgrade/migration procedures, and troubleshooting.

## Security Model & Invariants

All 25 formal requirements are specified and hashed in [`specs/architecture-and-contracts.md`](../specs/architecture-and-contracts.md) and mechanically checked by `spec_check.py` + Quint models (`specs/write_guard.qnt`, `specs/events_ingestion.qnt`).

### 1. Credential Hygiene (Zero Key in LLM or Logs)

- API keys are never accepted as MCP tool arguments, never echoed in JSON-RPC responses, and never written to SQLite in plaintext.
- In cloud mode, `createEncryptedCredentialVault` encrypts keys using **AES-256-GCM** with random IVs and Additional Authenticated Data (AAD) `issuer\0principalId\0instanceUrl`, preventing cross-tenant ciphertext swapping.
- Binding tickets (`/bind`) and approval tickets (`/approve`) enforce HttpOnly opener-session verification, CSRF timing-safe tokens, short TTLs, and single-use atomic claims.

### 2. Tiered Write Guard & Indeterminate Safety

- **Safe-Auto (`bugzilla_post_analysis`)**: Always requires `isPrivate: true`. If `probeCapabilities().isInsider` is false or Bugzilla returns error code `113` (`private_rejected`), the server saves a tenant-scoped server-local internal note (`SavedAsInternalNote`) and performs **zero** upstream public writes.
- **Guarded-Write (`bugzilla_propose_update` / `app_resolve_proposal`)**:
  - Checks upstream `last_change_time` against `expectedLastChangeTime` before dispatch; mismatches return `StaleBugConflict` with the latest authorized snapshot and require a new immutable proposal revision.
  - Cloud approvals require a single-use HMAC-SHA256 token whose JTI is durably persisted in SQLite (`consumed_jtis`) to prevent cross-restart replays.
  - Uncertain post-dispatch upstream errors transition the idempotency receipt to `OperationIndeterminate` rather than blindly retrying and creating duplicate bugs/comments.

### 3. Multi-Issuer Tenant Isolation (`[R-970164]`)

- Every tenant-scoped server table, index, approval token, event cursor scope hash, legacy HTTP session, and MCP App `tenantKey` is partitioned by `(issuer, principalId, instanceUrl)`.
- The reserved migration quarantine namespace `legacy://migrated` (`RESERVED_LEGACY_ISSUER`) is rejected at `PrincipalContextSchema`, HTTP `authenticate`, `/bind`, `/approve`, and `stdio` startup before any storage query runs.
- Restricted and non-existent Bugzilla bugs return indistinguishable error payloads (`INDISTINGUISHABLE_RESOURCE_ERROR`) to prevent existence oracles.

## Bugzilla 5.0 / 5.2+ Quirks & Proxy Checklist

These real-world behaviors were validated directly against a live self-hosted Bugzilla 5.2 container (`docker/bugzilla/`):

1. **`X-BUGZILLA-API-KEY` Header vs. Stock 5.0 / 5.2**:
   - `bugzilla-client` sends `X-BUGZILLA-API-KEY` header by default (`allowQueryFallback: false`).
   - Stock Bugzilla 5.0/5.2 ignores `X-BUGZILLA-API-KEY` unless running behind a reverse proxy rewrite or Bugzilla 5.3+.
   - **Recommended production fix**: Configure your reverse proxy (Apache/Nginx) to scrub query strings from access logs (`%U` instead of `%r` — see [`docker/bugzilla/bugzilla.conf`](../docker/bugzilla/bugzilla.conf)) and either rewrite the header at the proxy or explicitly opt in with `BUGZILLA_ALLOW_QUERY_FALLBACK=true`.
2. **Missing `/rest/whoami` on Stock 5.2**:
   - Stock Bugzilla 5.2 returns HTTP `404` (`code 32614`) for `/rest/whoami`.
   - `bugzilla-client` automatically falls back to `/rest/user?match=*` and identifies the authenticated user via self-only fields (`saved_searches` / `saved_reports`).
3. **MariaDB `user_api_keys.last_used` Deadlocks**:
   - Parallel REST requests using the same Bugzilla API key contend on `UPDATE user_api_keys SET last_used = ...` in MariaDB/MySQL, causing intermittent HTTP 500 deadlocks.
   - `bugzilla-client` serializes upstream requests per API key via an internal FIFO queue (`enqueueForKey`) to eliminate these deadlocks automatically.
4. **Error-Code Classification**:
   - Codes `306` / `300` (HTTP 400): classified as `credential_revoked` (terminates affected webhook subscriptions).
   - Codes `101`, `102`, `110`, `111`, `505` (HTTP 401/404): classified as `restricted_or_missing` (mapped to opaque indistinguishable errors).
   - Code `113`: classified as `private_rejected` (triggers fail-closed `SavedAsInternalNote`).

## SQLite Storage & Pre-v3 Migration Runbook

### Storage Characteristics

- Opens in SQLite **WAL mode** with `busy_timeout = 5000`.
- Internal note IDs are returned via `RETURNING CAST(id AS TEXT)` and read via `SELECT CAST(id AS TEXT)` so 64-bit SQLite sequences above `Number.MAX_SAFE_INTEGER` never suffer floating-point rounding or `ERR_OUT_OF_RANGE`.

### Upgrading a Pre-v3 Database (Before Commit `f2b8ade`)

Opening a pre-v3 database with `createSqliteStorage(dbPath)` automatically executes an atomic `BEGIN IMMEDIATE ... COMMIT` migration:

1. Rebuilds all 6 tenant tables (`receipts`, `write_audits`, `internal_notes`, `proposals`, `drafts`, `webhook_subscriptions`) with `issuer TEXT NOT NULL` (plus `instance_url` on `webhook_subscriptions` and composite PK on `write_audits`).
2. Strictly validates existing JSON blobs (`receipt_json`, `entry_json`, `proposal_json`, `sub_json`) and rolls back atomically on corrupt/non-object payloads.
3. Quarantines historical rows under `issuer = 'legacy://migrated'` so no live OAuth issuer can read another issuer's pre-upgrade drafts, proposals, notes, or webhook secrets.
4. Preserves `internal_notes` `sqlite_sequence` high-water marks in 64-bit integer arithmetic so deleted note IDs are never reused.
5. Recreates `idx_write_audits_lookup` and `idx_internal_notes_lookup` inside the same transaction.
6. **Duplicate-Write Protection Across Upgrade**: If a live issuer retries an idempotency key that matches a non-failed quarantined receipt in `legacy://migrated`, `reservePending` returns a redacted `OperationIndeterminate` without dispatching upstream or disclosing the legacy `artifactId`.

### Rollout Checklist

- **Back up** `*.sqlite`, `*.sqlite-wal`, and `*.sqlite-shm` (or run `VACUUM INTO 'backup.sqlite'`) before upgrading.
- **Stop all pre-v3 workers before starting v3 workers** against the same SQLite file: pre-v3 code queries `drafts` and `internal_notes` without an `issuer` predicate, so mixed-version concurrent access is not supported.
- Wait for v3 startup to complete cleanly before enabling multi-issuer traffic.

## Live E2E Testing & Troubleshooting

### Running Zero-Mock Live Bugzilla 5.2 E2E

The repository ships a self-contained Bugzilla 5.2 + MariaDB Docker Compose stack under [`docker/bugzilla/`](../docker/bugzilla/) with seeded admin/regular/restricted users and Apache zero-query logging:

```bash
cd docker/bugzilla && docker compose up -d --build --wait
cd ../.. && bun run test:e2e
```

To point the E2E suite at a custom port or URL, set `E2E_BUGZILLA_URL=http://127.0.0.1:<port>`. Always tear down disposable containers afterward:

```bash
cd docker/bugzilla && docker compose down -v
```

### Common Troubleshooting

| Symptom                                                    | Cause                                                                                | Fix                                                                                                                                              |
| :--------------------------------------------------------- | :----------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` on local HTTP `/mcp`                    | Missing or mismatched `Authorization: Bearer <MCP_LOCAL_TOKEN>`                      | Pass the exact `MCP_LOCAL_TOKEN` env var (local HTTP fails closed without a token).                                                              |
| `403 Forbidden Host header` on local HTTP                  | Request `Host` header is not `127.0.0.1`, `localhost`, or `[::1]`                    | Connect via loopback only (DNS rebinding guard).                                                                                                 |
| `bugzilla_post_analysis` returns `SavedAsInternalNote`     | Bugzilla user lacks `insidergroup` privilege or Bugzilla rejected `is_private: true` | Grant the Bugzilla user insider group membership if private Bugzilla comments are desired; otherwise server-local notes are working as designed. |
| `CredentialBindingRequired` or `401` on stock Bugzilla 5.2 | Stock 5.2 ignores `X-BUGZILLA-API-KEY` header                                        | Configure reverse-proxy header forwarding or scrub access logs (`%U`) and set `BUGZILLA_ALLOW_QUERY_FALLBACK=true`.                              |
| `UI resource missing`                                      | `packages/app-ui/dist-web/triage-app.html` has not been built                        | Run `bun run build:ui`.                                                                                                                          |
| Migration throws `Failed to migrate ...: malformed JSON`   | Pre-v3 SQLite file contains corrupt JSON in a legacy table                           | Migration rolled back atomically; inspect and repair/remove the corrupt row in a backup copy before retrying startup.                            |
