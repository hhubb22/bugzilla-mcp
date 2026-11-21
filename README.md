# `bugzilla-mcp`

Dual-mode (Cloud Autonomous Agent + Local IDE / Antigravity) **MCP Server** for self-hosted **Bugzilla 5.0 / 5.2+**, built with TypeScript, **Bun**, and **VoidZero (`vite-plus`)**, aligned with:

- **MCP Core `2026-07-28`** (+ `2025-11-25` Dual-Era session compatibility)
- **MCP Apps (`SEP-1865`)** single-file React workbench (`ui://bugzilla/triage-app.html`)
- **MCP Events (`SEP-3415` + ChatGPT Events dialect adapter)**

## Packages

| Package                                                | Responsibility                                                                                                                                                                                                                                     |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/contracts`](packages/contracts)             | Strict Zod schemas & TypeScript contracts (`C0` baseline)                                                                                                                                                                                          |
| [`packages/storage`](packages/storage)                 | `StoragePorts` + SQLite (`node:sqlite` WAL) persistence for receipts, proposals, drafts, audits, JTI replay guards, encrypted credentials, and webhook queues                                                                                      |
| [`packages/bugzilla-client`](packages/bugzilla-client) | Self-hosted Bugzilla REST client (header auth default, explicit `allowQueryFallback` for stock 5.0/5.2, per-key serialization preventing `user_api_keys.last_used` MariaDB deadlocks, error-code classification, bounded text attachment excerpts) |
| [`packages/core`](packages/core)                       | Tiered Write Guard (`Safe-Auto` non-degradable private comments + `Guarded-Write` optimistic `last_change_time` check & audit), Cloud single-use signed approval tokens, SSRF-hardened DNS-pinned Standard Webhooks, and Synthetic Events engine   |
| [`packages/app-ui`](packages/app-ui)                   | Pure sanitization & safe host controller + single-file React/Vite+ MCP App UI (`<= 4` unified concurrency gate, container-query responsive layout, native `<dialog>` confirmations)                                                                |
| [`packages/server`](packages/server)                   | Dual-Era Streamable HTTP handler, `/bind` URL Elicitation & `/approve` cloud human approval pages, AES-256-GCM credential vault, loopback-guarded local HTTP runtime, and `stdio` transport                                                        |

## Specs & Formal Models

All frozen specifications and Quint models live inside [`specs/`](specs/):

- [specs/brief.md](specs/brief.md)
- [specs/architecture-and-contracts.md](specs/architecture-and-contracts.md) (24 `[R-xxxxxx]` EARS clauses + 3 Parnas decision tables)
- [specs/auth-and-binding-flow.md](specs/auth-and-binding-flow.md)
- [specs/mcp-app-ux-design.md](specs/mcp-app-ux-design.md)
- [specs/write_guard.qnt](specs/write_guard.qnt) & [specs/events_ingestion.qnt](specs/events_ingestion.qnt)

## Development & Verification

```bash
bun install
bun run build:ui        # Build single-file MCP App HTML (packages/app-ui/dist-web/triage-app.html)
bun run check           # Format + Oxlint (vite-plus)
bun run typecheck       # Type-check all 6 workspaces + React web bundle
bun run test            # Locked C1 blind contract suite (74 tests)
bun run verify:quint    # Quint formal safety invariants
```

## Live OrbStack Bugzilla 5.2 Zero-Mock E2E

```bash
cd docker/bugzilla && docker compose up -d --build --wait
cd ../.. && bun run test:e2e
# Tear down temporary Bugzilla when done:
cd docker/bugzilla && docker compose down -v
```

## Local IDE Usage (`stdio` or Loopback HTTP)

```bash
# stdio (Antigravity / Claude Desktop / Cursor)
BUGZILLA_BASE_URL=http://127.0.0.1:18080 \
BUGZILLA_API_KEY=<your-key> \
BUGZILLA_ALLOW_QUERY_FALLBACK=true \
BUGZILLA_DB_PATH=./bugzilla-mcp.sqlite \
bun run packages/server/src/cli.ts --transport=stdio

# Loopback Streamable HTTP (requires MCP_LOCAL_TOKEN + loopback Host header)
BUGZILLA_BASE_URL=http://127.0.0.1:18080 \
BUGZILLA_API_KEY=<your-key> \
MCP_LOCAL_TOKEN=<random-token> \
bun run packages/server/src/cli.ts --transport=http --port=3878
```
