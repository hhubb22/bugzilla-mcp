# Bugzilla Frontier MCP Server (`bugzilla-mcp`)

Dual-mode (Cloud Autonomous Agent + Local IDE/Antigravity) MCP Server for self-hosted Bugzilla 5.0/5.2+, built on **MCP Core `2026-07-28`** (+ `2025-11-25` Dual-Era), **MCP Apps (SEP-1865)**, and **MCP Events (SEP-3415 + ChatGPT Dialect)**.

## Specifications & Formal Models (`specs/`)
- [Product Framing Brief](./specs/brief.md)
- [Architecture & Frozen C0 Contracts](./specs/architecture-and-contracts.md)
- [Cloud OAuth 2.1 (CIMD) & URL Elicitation Binding Flow](./specs/auth-and-binding-flow.md)
- [MCP App Triage Workbench UX Design](./specs/mcp-app-ux-design.md)
- Formal Quint Models: [write_guard.qnt](./specs/write_guard.qnt) · [events_ingestion.qnt](./specs/events_ingestion.qnt)

## Packages
- `packages/contracts`: Pure TypeScript/Zod schemas, discriminated unions, error domains, and `C0` public service contracts.
- `packages/bugzilla-client`: Self-hosted Bugzilla REST v1 client adapter (version probe, auth fallback, field projection).
- `packages/storage`: Storage ports + Drizzle SQLite (v1) / PostgreSQL (Phase 2) adapters.
- `packages/core`: Transport-agnostic domain kernel (Dossier, Write Guard, Synthetic Events, SSRF-hardened Webhook sender).
- `packages/server`: Dual-Era Streamable HTTP & stdio transports, OAuth/Elicitation endpoints, SEP-3415 & ChatGPT Events adapters.
- `packages/app-ui`: Single-file MCP App (`@modelcontextprotocol/ext-apps`) for `aux_pane`, `global`, and `inline` surfaces.
