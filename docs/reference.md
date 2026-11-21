# Technical Reference

Complete reference for `bugzilla-mcp` CLI flags, environment variables, MCP tools, resources, events, webhooks, and HTTP routes.

## CLI Flags & Environment Variables

Entry point: `bun run packages/server/src/cli.ts [--transport=stdio|http] [--host=127.0.0.1] [--port=3878]`

| Variable / Flag                 | Default                             | Description                                                                                                                                         |
| :------------------------------ | :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--transport` / `MCP_TRANSPORT` | `stdio`                             | Transport mode (`stdio` or `http`). Cloud mode rejects `stdio`.                                                                                     |
| `--host` / `HOST`               | `127.0.0.1`                         | Bind host for HTTP mode. `local-trusted-ide` strictly enforces loopback (`127.0.0.1`, `localhost`, `::1`).                                          |
| `--port` / `PORT`               | `3878`                              | Bind port for HTTP mode.                                                                                                                            |
| `BUGZILLA_BASE_URL`             | `http://127.0.0.1:18080`            | Base URL of the self-hosted Bugzilla instance.                                                                                                      |
| `BUGZILLA_API_KEY`              | `""` (unbound)                      | Local IDE Bugzilla API key. Never logged or exposed to the model.                                                                                   |
| `BUGZILLA_ALLOW_QUERY_FALLBACK` | `false`                             | Opt-in fallback for stock Bugzilla 5.0/5.2 that ignores `X-BUGZILLA-API-KEY`. Enable **only** when upstream access logs strip query strings (`%U`). |
| `BUGZILLA_DB_PATH`              | `:memory:`                          | SQLite WAL file path for durable receipts, proposals, drafts, audits, JTI guards, and webhook queues.                                               |
| `BUGZILLA_PRINCIPAL_ID`         | `local-user`                        | Local principal identifier for `local-trusted-ide` mode.                                                                                            |
| `MCP_DEPLOYMENT_MODE`           | `local-trusted-ide`                 | Deployment mode (`local-trusted-ide` or `cloud-multi-user`; cloud mode requires programmatic `startMcpHttpServer`).                                 |
| `MCP_EVENTS_PROFILE`            | `sep-3415`                          | Events dialect: `sep-3415` (standard MCP Events) or `chatgpt-events` (ChatGPT Events adapter).                                                      |
| `MCP_LOCAL_TOKEN`               | Random 24-byte base64url            | Per-installation bearer token required for local Streamable HTTP requests.                                                                          |
| `MCP_ALLOWED_ORIGINS`           | `http://127.0.0.1,http://localhost` | Comma-separated CORS/Origin allowlist for HTTP requests.                                                                                            |
| `MCP_SIGNING_SECRET`            | Random 32-byte hex                  | HMAC-SHA256 signing secret for approval tokens and binding tickets. Set a persistent secret in production.                                          |
| `MCP_LAG_WINDOW_MS`             | `3000`                              | Lag window (ms) held back before advancing event cursors so delayed upstream commits are not skipped.                                               |
| `MCP_CAUSAL_MAX_WRITES`         | `5`                                 | Max causal agent writes per `(instanceUrl, bugId)` inside `MCP_CAUSAL_WINDOW_MS`.                                                                   |
| `MCP_CAUSAL_WINDOW_MS`          | `300000`                            | Sliding window (ms) for per-bug causal write budget (anti-loop protection).                                                                         |

## MCP Tools (11 Total)

### Model-Facing Tools (7)

| Tool                              | Scope              | Safety Tier       | Description                                                                                                                                                             |
| :-------------------------------- | :----------------- | :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bugzilla_search`                 | `bz:read`          | Read-Only         | Compact projected bug search with product/component/status/assignee/updatedSince/query filters (`limit <= 50`).                                                         |
| `bugzilla_get_dossier`            | `bz:read`          | Read-Only         | Compact dossier (metadata, bounded comments/history, server-local internal notes, `tenantKey`) linked to `ui://bugzilla/dossier-card.html`.                             |
| `bugzilla_triage_board`           | `bz:read`          | Read-Only         | Opens the interactive Triage Workbench (`ui://bugzilla/triage-app.html`) with server-derived `tenantKey` and pending proposal counts.                                   |
| `bugzilla_get_attachment_excerpt` | `bz:read`          | Read-Only         | Bounded text excerpt (`maxBytes <= 65536`) of a Bugzilla attachment; rejects binary/oversized payloads cleanly.                                                         |
| `bugzilla_post_analysis`          | `bz:write:safe`    | **Safe-Auto**     | Posts a private analysis comment (`isPrivate: true` mandatory). Fails closed to `SavedAsInternalNote` if caller is non-insider or upstream rejects private comments.    |
| `bugzilla_propose_update`         | `bz:write:guarded` | **Guarded-Write** | Creates an immutable revisioned update proposal (or executes directly if policy-granted / accompanied by valid approval) with `expectedLastChangeTime` freshness check. |
| `bugzilla_create_bug`             | `bz:write:guarded` | **Guarded-Write** | Creates a Bugzilla bug with idempotency receipt (`Applied`, `DuplicateNoOp`, `OperationPending`, `OperationIndeterminate`, `IdempotencyConflict`).                      |

### App-Only UI Tools (`visibility: ["app"]`, 4)

| Tool                   | Scope              | Description                                                                                                                                 |
| :--------------------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| `app_save_draft`       | `bz:read`          | Persists tenant-scoped UI draft text (`private_comment`, `public_comment`, `proposal_edit`) with monotonic `draftRevision` guard.           |
| `app_get_draft`        | `bz:read`          | Loads persisted tenant-scoped draft text for a bug inside the MCP App.                                                                      |
| `app_get_bug_full`     | `bz:read`          | Fetches full authorized dossier, persisted draft, and pending proposals for the selected bug.                                               |
| `app_resolve_proposal` | `bz:write:guarded` | Approves or rejects a pending proposal (`cloud_signed_token` required in cloud mode; `local_ide_host_confirmed` allowed in local IDE mode). |

## MCP Resources

| Resource URI                      | Scope     | Cache / Behavior                                                                                                                                                 |
| :-------------------------------- | :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bugzilla://bug/{id}`             | `bz:read` | Private (`ttlMs: 0`, `cacheScope: "private"`). Returns JSON dossier + tenant-scoped `internalNotes`; restricted and missing bugs return identical opaque errors. |
| `ui://bugzilla/triage-app.html`   | `bz:read` | Single-file React/Vite+ Triage Workbench (`text/html;profile=mcp-app`).                                                                                          |
| `ui://bugzilla/dossier-card.html` | `bz:read` | Inline bug dossier card view (`text/html;profile=mcp-app`).                                                                                                      |

## MCP Events & Standard Webhooks

### Event Types

| Event Name               | Trigger                        | Filter Arguments                                                       |
| :----------------------- | :----------------------------- | :--------------------------------------------------------------------- |
| `bugzilla.bug.created`   | New bug matching filters       | `product`, `component`, `bugIds` (`<= 100`), `severity`, `includeSelf` |
| `bugzilla.bug.updated`   | Field changes on matching bugs | Above + `watchedFields`                                                |
| `bugzilla.bug.commented` | New visible comment            | Above + `mentionMe`                                                    |
| `bugzilla.flag.needinfo` | `needinfo` flag set/changed    | Above + `requestee` (`"me"` or email)                                  |

### Cursor & Delivery Guarantees

- **Lag Window**: Events newer than `now - lagWindowMs` are held back until stable so late-committing DB transactions are never silently skipped.
- **Scope-Bound Cursors**: Cursors encode `{ v, scope, ts, tie }` where `scope` hashes `(issuer, principalId, instanceUrl, eventName, canonicalArgs)`. Cross-issuer, cross-instance, cross-filter, or out-of-range (`|ts| > 8.64e15`) cursors are rejected with `-32602 InvalidParams`.
- **Self-Write Suppression**: By default (`includeSelf: false`), writes performed by `bugzilla-mcp` on the same `(instanceUrl, bugId)` are suppressed via `self_writes` provenance to prevent infinite agent loops.
- **Standard Webhooks Security**:
  - Subscription secrets must match `^whsec_[A-Za-z0-9+/=]{32,88}$` (24–64 random bytes).
  - Outbound callbacks resolve DNS upfront, reject private/loopback/link-local/CGNAT IPs (SSRF protection), pin the resolved IP + `Host` + TLS SNI, and disable HTTP redirects (`followRedirects: false`).
  - Signatures use Standard Webhooks HMAC-SHA256 (`webhook-id`, `webhook-timestamp`, `webhook-signature`) with dual-secret rotation grace window.
  - Subscriptions are partitioned by `(issuer, principalId, instanceUrl, url, name, canonicalArgsJson)` with durable SQLite retry queues and per-principal / per-subscription fault isolation.

### Dialect Profiles

- **`sep-3415`** (default): Standard MCP Events (`events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe`, `gap` and `terminated` control envelopes).
- **`chatgpt-events`**: ChatGPT Events dialect compatibility adapter over the same underlying cursor & visibility engine.

## HTTP Endpoints

| Method & Path                               | Auth                                                 | Purpose                                                                                                                                                                           |
| :------------------------------------------ | :--------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource` | Public                                               | RFC 9728 OAuth Protected Resource Metadata discovery document.                                                                                                                    |
| `POST /mcp`                                 | Bearer token (`Authorization: Bearer ...`)           | Dual-Era Streamable HTTP JSON-RPC endpoint (`2026-07-28` stateless with `_meta` + mirror headers; `2025-11-25` stateful `Mcp-Session-Id` strictly bound to authenticated tenant). |
| `GET /bind?t=<ticket>`                      | Opener session cookie (`verifyBindingOpenerSession`) | Out-of-band HTTPS form to bind a user's Bugzilla API key (CSRF-protected, single-use, never touches LLM context).                                                                 |
| `POST /bind`                                | Opener session cookie + CSRF token                   | Encrypts and stores API key in AES-256-GCM vault bound to `(issuer, principalId, instanceUrl)` and issues single-use signed continuation state.                                   |
| `GET /approve?t=<ticket>`                   | Opener session cookie (`verifyBindingOpenerSession`) | Out-of-band HTTPS human review page showing exact proposal diff & target bug visibility check.                                                                                    |
| `POST /approve`                             | Opener session cookie + CSRF token                   | Mints a single-use HMAC-SHA256 approval token bound to `(approverIssuer, approverPrincipalId, instanceUrl, proposalId, revision, bugId, baseVersion, diffHash, visibility)`.      |
