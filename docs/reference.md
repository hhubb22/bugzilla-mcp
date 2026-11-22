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
| `MCP_WEBHOOK_ENABLED`           | `false`                             | Enable Webhook delivery in HTTP mode. Requires authentication, a Bugzilla credential binding, and file-backed SQLite.                               |
| `MCP_READ_ONLY`                 | `false`                             | List only read tools and reject direct calls to write tools in HTTP mode.                                                                           |
| `MCP_MAX_WEBHOOK_RETRIES`       | `3`                                 | Additional attempts after the first Webhook send. Nonnegative integer.                                                                              |
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

| Event Name               | Trigger                        | Filter Arguments                                                  |
| :----------------------- | :----------------------------- | :---------------------------------------------------------------- |
| `bugzilla.bug.created`   | New bug matching filters       | `product`, `component`, `severity`, `includeSelf`                 |
| `bugzilla.bug.updated`   | Field changes on matching bugs | `product`, `bugIds` (`<= 100`), `watchedFields`, `includeSelf`    |
| `bugzilla.bug.commented` | New visible comment            | `product`, `bugIds` (`<= 100`), `mentionMe`, `includeSelf`        |
| `bugzilla.flag.needinfo` | `needinfo` flag set/changed    | `product`, `requestee` (`"me"` or a Bugzilla user), `includeSelf` |

### Cursor & Delivery Guarantees

- **Lag Window**: Events newer than `now - lagWindowMs` are held back. The window covers upstream changes that become visible within it, not arbitrarily late changes. An incomplete scan returns `-32603` with `data.reason: "scan_incomplete"` and no replacement cursor.
- **Scope-Bound Cursors**: Use a cursor only with the same tenant, Bugzilla credential generation, event and filters. A malformed or foreign cursor returns `-32602`; an outdated schema epoch returns `-32026` with `data.reason: "schema_changed"`.
- **Self-Write Suppression**: With `includeSelf: false` (default), an event is suppressed only when confirmed write provenance uniquely identifies it for that tenant. The server preserves events with ambiguous history and doesn't match by comment text or author.
- **Severity**: Creation filters compare the exact severity at collection. Retries keep that selection.
- **Standard Webhooks Security**:
  - Subscription secrets must match `^whsec_[A-Za-z0-9+/=]{32,88}$` (24–64 random bytes).
  - Before each outbound connection, the sender validates all DNS results, pins a public IP while preserving `Host` and TLS SNI, and does not follow redirects.
  - Signatures use Standard Webhooks HMAC-SHA256 (`webhook-id`, `webhook-timestamp`, `webhook-signature`) with dual-secret rotation grace window.
  - Subscriptions are partitioned by `(issuer, principalId, instanceUrl, url, name, canonicalArgsJson)` with durable SQLite retry queues and per-principal / per-subscription fault isolation.

### Dialect Profiles

- **`sep-3415`** (default): `events/list` and `events/poll`. When Webhook delivery is enabled, supports subscribe and unsubscribe, plus signed `gap` and `terminated` messages.
- **`chatgpt-events`**: Webhook-only on both HTTP protocol revisions. With Webhook delivery off, the server does not advertise Events. It reports a delivery gap with `truncated: true` on refresh, not with a control message.

Neither profile advertises `push`. A callback `2xx` acknowledges receipt, not host
triage completion. Check the HTTP process's `stderr` for one `mcp.events.scan` JSON
record per state transition, with an opaque `subscriptionId` and a `state` of
`idle`, `active`, `scan_incomplete`, or `authorization_revoked`.

## HTTP Endpoints

| Method & Path                               | Auth                                                 | Purpose                                                                                                                                                                           |
| :------------------------------------------ | :--------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource` | Public                                               | RFC 9728 OAuth Protected Resource Metadata discovery document.                                                                                                                    |
| `POST /mcp`                                 | Bearer token (`Authorization: Bearer ...`)           | Dual-Era Streamable HTTP JSON-RPC endpoint (`2026-07-28` stateless with `_meta` + mirror headers; `2025-11-25` stateful `Mcp-Session-Id` strictly bound to authenticated tenant). |
| `GET /bind?t=<ticket>`                      | Opener session cookie (`verifyBindingOpenerSession`) | Out-of-band HTTPS form to bind a user's Bugzilla API key (CSRF-protected, single-use, never touches LLM context).                                                                 |
| `POST /bind`                                | Opener session cookie + CSRF token                   | Encrypts and stores API key in AES-256-GCM vault bound to `(issuer, principalId, instanceUrl)` and issues single-use signed continuation state.                                   |
| `GET /approve?t=<ticket>`                   | Opener session cookie (`verifyBindingOpenerSession`) | Out-of-band HTTPS human review page showing exact proposal diff & target bug visibility check.                                                                                    |
| `POST /approve`                             | Opener session cookie + CSRF token                   | Mints a single-use HMAC-SHA256 approval token bound to `(approverIssuer, approverPrincipalId, instanceUrl, proposalId, revision, bugId, baseVersion, diffHash, visibility)`.      |
