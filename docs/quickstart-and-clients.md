# Quick Start & Client Integration

This guide covers the three supported deployment modes of `bugzilla-mcp`:

1. [Local IDE (`stdio`)](#1-local-ide-stdio)
2. [Local Loopback Streamable HTTP](#2-local-loopback-streamable-http)
3. [Cloud Multi-User Embedding (`startMcpHttpServer`)](#3-cloud-multi-user-embedding)

## Prerequisites

- **Bun** `>= 1.4` (tested with `1.4.5`) or **Node.js** `>= 22` with `node:sqlite`
- A reachable self-hosted **Bugzilla 5.0 / 5.2+** instance with REST API enabled
- A Bugzilla API key generated from `<BUGZILLA_BASE_URL>/userprefs.cgi?tab=apikey`

Install dependencies and build the single-file MCP App UI bundle once:

```bash
bun install
bun run build:ui
```

This produces `packages/app-ui/dist-web/triage-app.html`, served via `ui://bugzilla/triage-app.html` and `ui://bugzilla/dossier-card.html`.

## 1. Local IDE (`stdio`)

`stdio` is the simplest mode for Antigravity, Claude Desktop, Cursor, or any desktop MCP host.

- Persists proposals, receipts, drafts, internal notes, and audits in a local SQLite WAL file (`BUGZILLA_DB_PATH`).
- Supports both MCP `2026-07-28` (`server/discover`) and `2025-11-25` (`initialize`).
- Guarded writes (`bugzilla_propose_update` -> `app_resolve_proposal`) accept host-confirmed MCP App approvals (`local_ide_host_confirmed`) in `local-trusted-ide` mode.

### Example MCP Client Configuration

```json
{
  "mcpServers": {
    "bugzilla": {
      "command": "bun",
      "args": ["run", "/ABS/PATH/TO/bugzilla-mcp/packages/server/src/cli.ts", "--transport=stdio"],
      "env": {
        "BUGZILLA_BASE_URL": "https://bugzilla.example.internal",
        "BUGZILLA_API_KEY": "<your-bugzilla-api-key>",
        "BUGZILLA_PRINCIPAL_ID": "alice@example.internal",
        "BUGZILLA_DB_PATH": "/ABS/PATH/TO/bugzilla-mcp.sqlite"
      }
    }
  }
}
```

> **Tip**: If your Bugzilla instance is stock 5.0/5.2 without header auth support, see [Bugzilla 5.0 / 5.2+ Header Auth & Apache Logging](security-and-operations.md#bugzilla-50--52-quirks--proxy-checklist) before enabling `BUGZILLA_ALLOW_QUERY_FALLBACK=true`.

## 2. Local Loopback Streamable HTTP

Use loopback HTTP when connecting an MCP client or local browser workbench over HTTP.

Security defaults enforced automatically by `packages/server/src/runtime.ts` and `http-handler.ts`:

- Refuses to bind non-loopback hosts (`127.0.0.1`, `localhost`, `::1` only).
- Rejects non-loopback `Host` headers (`403`, DNS rebinding protection).
- Requires a non-empty `MCP_LOCAL_TOKEN` bearer token on every request (`401` fail-closed if omitted).

```bash
export MCP_LOCAL_TOKEN="$(openssl rand -base64 24)"
BUGZILLA_BASE_URL="https://bugzilla.example.internal" \
BUGZILLA_API_KEY="<your-bugzilla-api-key>" \
BUGZILLA_DB_PATH="./bugzilla-mcp.sqlite" \
MCP_LOCAL_TOKEN="$MCP_LOCAL_TOKEN" \
bun run packages/server/src/cli.ts --transport=http --host=127.0.0.1 --port=3878
```

Clients connect to `http://127.0.0.1:3878/mcp` with header `Authorization: Bearer <MCP_LOCAL_TOKEN>`.

HTTP starts with Webhook delivery off. Set `MCP_WEBHOOK_ENABLED=true` to enable it
with a bound Bugzilla credential and a file-backed `BUGZILLA_DB_PATH`. Set
`MCP_READ_ONLY=true` on a connector used for read-only triage.

## 3. Cloud Multi-User Embedding

In `cloud-multi-user` mode, the CLI intentionally fails fast because production cloud deployments **must** supply:

1. An OAuth 2.1 bearer token verifier (`authenticateBearerToken`) that verifies JWT `iss` / `sub` / `aud` / scopes and returns a `PrincipalContext`.
2. A browser session verifier (`verifyBindingOpenerSession`) for the `/bind` and `/approve` HTTPS pages so only the initiating `(issuer, principalId)` can bind an API key or mint a single-use approval token.
3. An encrypted credential vault (`createEncryptedCredentialVault`) with a KMS-managed master secret.

### Programmatic Wiring Example

```ts
import { createBugzillaClient } from "@bugzilla-mcp/bugzilla-client";
import type { PrincipalContext } from "@bugzilla-mcp/contracts";
import { createCloudApprovalTokenService } from "@bugzilla-mcp/core";
import {
  createEncryptedCredentialVault,
  startMcpHttpServer,
  type HttpServerConfig,
} from "@bugzilla-mcp/server";
import { createSqliteStorage } from "@bugzilla-mcp/storage";

const storage = createSqliteStorage(process.env.BUGZILLA_DB_PATH!);
const vault = createEncryptedCredentialVault(process.env.VAULT_MASTER_KEY!, storage);
const cloudApprovalService = createCloudApprovalTokenService(
  process.env.APPROVAL_SIGNING_SECRET!,
  storage,
);

const core = {
  storage,
  eventsProfile: "chatgpt-events" as const,
  lagWindowMs: 3_000,
  causalBudgetPerBug: 5,
  causalBudgetWindowMs: 300_000,
  cloudApprovalService,
  resolveClient: async (ctx: PrincipalContext) => {
    const cred = await vault.loadApiKey({
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
    });
    if (!cred) return null;
    return createBugzillaClient({
      baseUrl: ctx.instanceUrl,
      apiKey: cred.apiKey,
      allowQueryFallback: process.env.BUGZILLA_ALLOW_QUERY_FALLBACK === "true",
    });
  },
};

const config: HttpServerConfig = {
  mode: "cloud-multi-user",
  publicBaseUrl: "https://bugzilla-mcp.example.com",
  allowedOrigins: ["https://chatgpt.com", "https://claude.ai"],
  eventsProfile: "chatgpt-events",
  webhookEnabled: true,
  readOnly: true,
  bindingSecret: process.env.BINDING_SIGNING_SECRET!,
  core,
  authenticateBearerToken: async (token) => {
    // Verify JWT signature, audience, expiry, and issuer allowlist (never allow "legacy://migrated")
    return verifyOAuthAccessToken(token);
  },
  verifyBindingOpenerSession: async (req) => {
    // Verify HttpOnly session cookie for /bind and /approve pages
    return verifyBrowserSessionCookie(req.headers.cookie);
  },
  storeBoundApiKey: async (ctx, apiKey) => {
    return vault.storeApiKey({ ...ctx, apiKey });
  },
};

const running = await startMcpHttpServer({ config, host: "0.0.0.0", port: 8443 });

// On shutdown, await running.close() to stop HTTP and the delivery loop.
```

The HTTP runtime supplies the HTTPS sender and delivery loop. Use a file-backed
SQLite database for subscriptions and retries. `WebhookConfigurationError` means
the server did not start listening.

When your authorization provider can revoke a grant independently of its
Bugzilla credential, configure `resolveWebhookPrincipal` to load the current
principal and scopes for the stored grant, or return `null` when revoked. The
default cloud resolver checks the current stored credential generation. It does
not retain or replay the client's OAuth bearer token.

### Multi-Issuer Guarantees

Two distinct OAuth issuers (e.g. `https://idp-a.example` and `https://idp-b.example`) that assign the same `sub` (`principalId`) and connect to the same Bugzilla URL are strictly isolated across:

- Credential vault AAD (`issuer\0principalId\0instanceUrl`)
- All 6 tenant-scoped SQLite tables & indexes
- Cloud approval tokens (`approverIssuer` verified inside HMAC payload)
- Event cursors (`scopeHash` includes `issuer`) & webhook subscriptions
- Legacy `2025-11-25` HTTP sessions and MCP App UI `tenantKey` draft caches
