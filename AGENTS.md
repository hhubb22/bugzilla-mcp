# bugzilla-mcp Agent Guidelines (Track A: Stable-Core Effect v4)

This project uses **Effect v4 (`effect@^4.1.7`)** as its core typed-effect, error-channel, and schema spine (`packages/contracts`, `packages/bugzilla-client`, `packages/storage`, `packages/core`, `packages/server`), while keeping `packages/app-ui` strictly **`import type`-only** from `@bugzilla-mcp/contracts` (`0 B` Effect runtime in `triage-app.html`).

## 1. Mandatory Effect v4 Reference & Verification

- **ALWAYS** consult the installed Effect v4 docs and declarations before writing or modifying Effect code:
  - Installed guide: `packages/contracts/node_modules/effect/AGENTS.md` (and `node_modules/effect/ai-docs/src/` inside any package that depends on `effect`).
  - Installed `.d.ts` declarations: `packages/*/node_modules/effect/dist/` (`Effect.d.ts`, `Schema.d.ts`, `SchemaIssue.d.ts`, `Data.d.ts`, `Context.d.ts`, `Layer.d.ts`, `Schedule.d.ts`, `Semaphore.d.ts`, `ManagedRuntime.d.ts`, `testing/TestClock.d.ts`).
- Do **NOT** rely on 2024–2025 Effect v3 memory or external blog posts.
- Gate every edit on `bun run typecheck` (and package-scoped `bun --filter '<pkg>' typecheck`) plus `@effect/language-service` diagnostics.

## 2. Strict `@stability stable` Allowlist

Core packages (`contracts`, `bugzilla-client`, `storage`, `core`, `server`) may ONLY import `@stability stable` APIs from `effect`:

- **Allowed**:
  - `Effect`, `Effect.gen`, `Effect.fn`, `Effect.fnUntraced`, `Effect.catchTag`, `Effect.catchTags`, `Effect.onExit`, `Effect.uninterruptibleMask`, `Effect.matchCauseEffect`, `Effect.forkScoped`
  - `Context.Service`, `Context.Reference`, `Layer`, `ManagedRuntime`, `Scope`
  - `Data.TaggedError`, `Data.Error`, `Data.TaggedClass`, `Cause`, `Exit`, `Result`, `Option`, `Predicate`
  - `Schedule`, `Semaphore`, `DateTime`
  - `Schema`, `SchemaIssue`, `SchemaAST`, `SchemaTransformation`, `JsonSchema`
  - `effect/testing` (`TestClock`) for deterministic timer/backoff/lease tests (run under existing `vite-plus/test` & `bun test` via `Effect.runPromise(Effect.provide(eff, TestClock.layer()))`)

## 3. Explicitly Banned APIs (v3 / Beta / Unstable)

**NEVER** use any of the following in the core spine:

- **Effect v3 / Beta hallucinations**: `Context.Tag`, `Effect.Service`, `ServiceMap`, `Either` (use `Result` in v4), `@effect/platform`, `@effect/platform-node`, `@effect/sql`, `@effect/schema`, `@effect/vitest`.
- **`@stability unstable` Effect v4 subpaths** (banned in core spine): `effect/http`, `effect/sql`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, `effect/workflow`, `effect/cluster`.
  - Keep `packages/storage` on built-in `node:sqlite` (`DatabaseSync` + `db.isTransaction` `withTransaction`) exposed through a `Context.Service` port.
  - Keep `packages/bugzilla-client` on standard `fetch` wrapped in `Effect` with bounded `AbortSignal.timeout`.
  - Any optional durable-execution testbed (`effect/workflow` `SingleRunner`) is strictly isolated behind `WebhookSchedulerPort` under an opt-in adapter flag (`MCP_EVENTS_SCHEDULER=effect-workflow`) and separate `.workflow.db` file — never in core `write-guard` or `proposals`.

## 4. Architecture & Safety Guardrails

1. **Effect-Certainty & Stage 3 Write Interruption Rule**:
   - Every upstream/domain error carries explicit `effectCertainty: "none" | "uncertain"`. Never classify a deterministic `effectCertainty: "none"` rejection (e.g. Bugzilla 4xx, `401`/`300`/`306`/`410`, `403`/`404`, `429`) as `OperationIndeterminate`.
   - Never pass an Effect fiber interruption `AbortSignal` into non-idempotent Bugzilla `POST`/`PUT` `fetch` calls (use only bounded `AbortSignal.timeout`). Keep `[markDispatchStarted -> single POST/PUT fetch -> Stage 4 commitAppliedMutation]` uninterruptible.
2. **Schema Strictness vs MCP Passthrough**:
   - Do **not** blindly strip unknown keys on `ProposalDiff` or event filters (enforce strict unknown-key rejection).
   - **Preserve passthrough** on `ClientCapabilitiesSchema` and `ModernRequestMetaSchema` so unknown MCP client capabilities and `_meta` keys are never rejected.
   - Always use `Schema.Int` / `Schema.Finite` (never bare `Schema.Number`) for JSON-serialized numbers so JSON Schema 2020-12 stays clean.
3. **UI Bundle Isolation (`0 B` Effect in `app-ui`)**:
   - `packages/app-ui/src/**` MUST only use `import type { ... } from "@bugzilla-mcp/contracts"`. Never add runtime imports from `@bugzilla-mcp/contracts` or `effect` in `packages/app-ui`.
4. **Runtime Lifecycle & Test Parity**:
   - Always wire `await runtime.dispose()` into HTTP server `close()` and stdio `EOF`/`SIGINT` handlers so `Effect.forkScoped` fibers never leak timers or hang test runners.
   - Expose thin Promise facades at `core`/`server` entrypoints so existing black-box tests remain decoupled.
