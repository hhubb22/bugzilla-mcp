# Bugzilla Frontier MCP Server: 架构与契约规范（C0 Frozen）

> 上游基线：[brief.md](./brief.md) · 鉴权与绑定细化：[auth-and-binding-flow.md](./auth-and-binding-flow.md) · MCP App 交互设计：[mcp-app-ux-design.md](./mcp-app-ux-design.md)
> 技术栈：TypeScript + Bun (1.3+ Workspaces & `bun:sqlite`) + VoidZero (`vite-plus`: Rolldown / Oxlint / Oxfmt / Vitest) · 协议基线：MCP Core `2026-07-28` (+ `2025-11-25` Dual-Era) · SEP-1865 (MCP Apps) · SEP-3415 (MCP Events)

## 1. TS 项目结构与分层架构

采用单仓库多包（`Bun workspaces`）+ VoidZero 统一工具链（`vite-plus`：`vp check` / `vp test` / `vp build`）+ 强类型契约优先（`zod` / TypeScript strict）布局，确保云端、本地与前端 MCP App 共享同一套领域类型与 Schema，避免漂移：

```text
bugzilla-mcp/
├── package.json                # Bun workspaces + vite-plus + quint
├── vite.config.ts              # VoidZero (Oxlint / Oxfmt / Vitest / Rolldown) 统一配置
├── packages/
│   ├── contracts/              # [纯类型 + Zod Schema + 错误域 + 游标/状态联合类型]（零运行时副作用）
│   │   ├── src/
│   │   │   ├── mcp-wire.ts     # 2026-07-28 + 2025-11-25 协议信封、CacheableResult、MRTR
│   │   │   ├── events.ts       # SEP-3415 事件目录、Cursor、Webhook 信封 + ChatGPT Dialect 类型
│   │   │   ├── domain.ts       # BugDossier、Proposal、WritePolicy、IdempotencyKey、ErrorDomain
│   │   │   └── tools.ts        # 7 个模型工具 + 4 个 App-only 工具的 Input/Output Schema
│   ├── bugzilla-client/        # [自建 Bugzilla REST v1 适配层]
│   │   └── src/                # 版本探测(5.0/5.2+)、Header/Query 认证回退、字段投影、重试退避
│   ├── core/                   # [纯业务逻辑内核，传输无关]
│   │   └── src/
│   │       ├── dossier/        # Dossier 聚合、附件文本截断、实例 Schema 内省缓存
│   │       ├── guard/          # 分级写入门禁、提案状态机、幂等与防循环护栏
│   │       ├── events/         # 合成事件引擎(last_change_time+history+comment)、游标与去重
│   │       └── webhook/        # SSRF 防护拨号器、Standard Webhooks HMAC 签名与轮转、Challenge 校验
│   ├── storage/                # [可插拔持久化端口]
│   │   └── src/
│   │       ├── ports.ts        # CredentialStore / ProposalStore / SubscriptionStore / IdempotencyStore
│   │       ├── sqlite.ts       # 本地单用户 / 单机轻量部署（Bun 内置 bun:sqlite + Drizzle）
│   │       └── postgres.ts     # 云端多用户高可用部署（含加密信封凭据与分布式租约锁）
│   ├── server/                 # [MCP 协议入口与双代路由]
│   │   └── src/
│   │       ├── transport-http.ts   # Streamable HTTP(Origin校验/镜像头校验/OAuth2.1+CIMD/URL Elicitation)
│   │       ├── transport-stdio.ts  # 本地 stdio 入口（直连环境变量 API Key，复用同一 core）
│   │       ├── dialect-events.ts   # SEP-3415 默认协议 + ChatGPT Events Dialect Adapter
│   │       └── mcp-app-host.ts     # 暴露 ui://bugzilla/triage-app.html 与 visibility:["app"] 路由
│   └── app-ui/                 # [MCP App 前端（SEP-1865）]
│       └── src/                # React + @modelcontextprotocol/ext-apps，Vite + vite-plugin-singlefile
└── specs/                      # 冻结的 Framing Brief、EARS 契约与 Quint 模型（如有）
```

**分层边界原则**：
- `contracts` 只能被单向依赖，所有外部入参在入口处 `Parse, Don't Validate`；
- `core` 严禁直接依赖 HTTP/stdio 或具体数据库驱动，全部通过 `storage/ports` 与 `bugzilla-client` 接口注入，确保黑盒/属性测试可无外部依赖运行；
- `app-ui` 打包为单个自包含 HTML（`< 10 MiB`，推荐 `< 300 KiB`），默认严格 CSP（`default-src 'none'`），不直连 Bugzilla、不依赖 `localStorage`。

## 2. 混合部署与存储边界

| 维度 | 云端多用户模式（Cloud Autonomous First） | 本地单用户模式（Local IDE / Antigravity） |
| :--- | :--- | :--- |
| **传输协议** | Streamable HTTP（HTTPS + `Origin` 白名单 + 镜像头校验） | `stdio`（默认）或 `localhost` Streamable HTTP |
| **调用方鉴权** | OAuth 2.1 + RFC 9728 Metadata + CIMD（校验 `aud`/`resource` 与 `iss`，禁透传上游） | 无 OAuth，信任本地进程环境 |
| **Bugzilla 凭据** | 每 `principal` 独立绑定个人 API Key（通过 **URL Elicitation** 引导绑定，服务端 KMS/AES-256-GCM 加密落库） | 读取环境变量 `BUGZILLA_API_KEY` 与 `BUGZILLA_BASE_URL` |
| **存储后端** | 端口抽象 + Drizzle 统一 Schema；v1 先落地 SQLite（支持单机云端与本地），Phase 2 无缝挂入 PostgreSQL 适配器支撑多副本云端 | SQLite（`${PLUGIN_DATA}/state.db`）或纯内存（无状态 `poll` 时可零落盘） |
| **核心交互面** | MCP Events（`webhook` + `poll`）+ 无头 Tools/Resources + 策略审批 | MCP Apps（`aux_pane` + `global` 看板）+ `stream`/`poll` + Form Elicitation |
| **缓存隔离** | 全部个人视图强制 `cacheScope: "private"`；仅公开实例元信息可短周期共享 | 单用户上下文仍显式标记 `cacheScope: "private"`（统一不变量） |

## 3. 对外原语与 Wire Schema（Tools / Resources / Events / MCP App）

### 3.1 面向模型的 Tools（7 个，均声明 `inputSchema` + `outputSchema` + 标准 `ToolAnnotations`）

> `ToolAnnotations` 严格使用 MCP `2026-07-28` Schema 字段名（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`）。为避免租户/私有缺陷信息通过 `Mcp-Param-*` 暴露给中间代理，**默认不把 `bugId` 或敏感 `product` 标为 `x-mcp-header`**（仅在部署策略显式声明为公开非敏感键时启用）。

| Tool Name | `ToolAnnotations` | UI 表面绑定 | 核心入参 / 出参契约 |
| :--- | :--- | :--- | :--- |
| `bugzilla_search` | `readOnlyHint: true`, `idempotentHint: true` | 无 | 入参：`product?`, `component?`, `status[]?`, `assignedTo?`, `updatedSince?`, `query?`, `limit(<=50)`, `offset`<br>出参：`{ items: BugSummary[], nextOffset?, totalHint? }`（严格字段投影，无正文/附件） |
| `bugzilla_get_dossier` | `readOnlyHint: true`, `idempotentHint: true` | **仅 Inline**（`ui://bugzilla/dossier-card.html`，不声明 `aux_pane`） | 入参：`bugId`, `maxComments(default 15)`, `maxHistory(default 30)`<br>出参：`BugDossier`（核心字段 + 精简流转 + 近期评论 + 附件元数据 + 服务端内部笔记，剥离 Base64 `data`，完整序列化 `<= 128 KiB`） |
| `bugzilla_triage_board` | `readOnlyHint: true`, `idempotentHint: true` | **`aux_pane` + `global`**（`ui://bugzilla/triage-app.html`，带类型化 entrypoint 对象；无 UI 宿主回退文本摘要） | 入参全可选（空 `{}` 返回当前用户“待审提案 / Needinfo / 我负责”默认队列，完整序列化 `<= 128 KiB`） |
| `bugzilla_post_analysis` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` *(上游无原生幂等键，由网关状态机保障)* | 无 | **Safe-Auto（私有不可降级）**：`isPrivate` 恒为 `true`（拒绝公评入参）；用户有 `insidergroup` 权限则写 Bugzilla 私有评论，无权限或拒绝则 **Fail-Closed 落为服务端内部笔记（零公写）**；必填 `idempotencyKey`；返回 `applied \| saved_as_internal_note \| duplicate_noop \| indeterminate` |
| `bugzilla_propose_update` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false` | 无 | **Guarded-Write**：变更 `status`/`resolution`/`assignedTo`/`priority`/`flags`/公开评论；必填 `idempotencyKey` 与 `expectedLastChangeTime`；默认创建不可变 `ProposalPending(proposalId, revision)`；仅在具备有效策略放行或独立审批凭证时执行“执行前乐观检查 + 写后差异审计” |
| `bugzilla_create_bug` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | 无 | 必填 `idempotencyKey` 与发布策略级别；缺失实例必填字段时，若现代请求声明 `elicitation.form` 返回 `input_required` 动态表单，否则返回结构化缺参提示 |
| `bugzilla_get_attachment_excerpt` | `readOnlyHint: true`, `idempotentHint: true` | 无 | 入参：`attachmentId`, `byteOffset(default 0)`, `maxBytes(<=65536)`；拒绝二进制非文本 MIME，仅按范围截断返回文本 |

### 3.2 App-Only Tools（`visibility: ["app"]`，仅供 UI 交互辅助，**不作为审批鉴权边界**）

- `app_list_queue`：看板分页、排序、多维筛选与待审提案计数（不受 1 MiB trajectory 限制）。
- `app_get_bug_full`：按需加载完整评论流、全量变更历史与关联提案详情。
- `app_resolve_proposal`：在本地可信 IDE 模式直接提交确认/驳回；在云端多用户模式下仅接受服务端独立 HTTPS `/approve` 页面签发的一次性签名审批凭证（或返回 `/approve` 跳转链接），无凭证直接调用必须拒绝。
- `app_save_draft`：按 `(principal, instance, bugId, draftKind)` 与单调递增 `draftRevision` 持久化草稿（拒绝旧版本覆盖新版本）。

### 3.3 Resources 与 `CacheableResult` 范围

> `CacheableResult`（`ttlMs >= 0` + `cacheScope`）严格仅用于规范定义的可缓存核心方法：`server/discover`、`tools/list`、`prompts/list`、`resources/list`、`resources/templates/list`、`resources/read`（不挂在 `tools/call` 响应上）。服务端内部缓存严格按 `(principal, instance, credentialGeneration)` 分区隔离。

| URI 模板 | `cacheScope` | 建议 `ttlMs` | 用途 |
| :--- | :--- | :--- | :--- |
| `bugzilla://bug/{id}` | `"private"` | `0`（敏感缺陷协议层立即可过期，每次读前重验当前权限） | Dossier JSON，供 MCP App `updateModelContext` 作为 `resource_link` 挂载 |
| `bugzilla://bug/{id}/history` | `"private"` | `0` | 结构化审计流转时间线 |
| `bugzilla://schema/fields` | `"private"` | `600_000` | 实例字段与合法状态机字典 |
| `bugzilla://schema/products` | `"private"` | `300_000` | 当前用户可见的 Product/Component/Version/Milestone 树 |
| `ui://bugzilla/triage-app.html` / `dossier-card.html` | `"public"` | `3_600_000` | MIME `text/html;profile=mcp-app`，静态自包含前端应用 |

### 3.4 MCP Events 目录与有界延迟合成模型（SEP-3415 + ChatGPT Dialect）

**Profile 选择**：部署/连接器配置在 `server/discover` 前静态锁定 `eventsProfile: "sep-3415" | "chatgpt-events"`（本地无鉴权端点不广播 `webhook` 交付模式）。

事件目录（均含严格 `inputSchema` + `payloadSchema`，SEP-3415 支持 `["poll", "push", "webhook"]`，ChatGPT Profile 裁剪为 `["webhook"]`）：
- `bugzilla.bug.created` — `{ product?, component?, severity?, includeSelf?: false }`
- `bugzilla.bug.updated` — `{ product?, bugIds?, watchedFields?: ["status","assigned_to","priority","flags"], includeSelf?: false }`
- `bugzilla.bug.commented` — `{ product?, bugIds?, mentionMe?: boolean, includeSelf?: false }`
- `bugzilla.flag.needinfo` — `{ requestee?: "me" | string, product?, includeSelf?: false }`（映射到经实例验证的 flag 类型变更）

**完整事件发生体（`EventOccurrence`）**：
- 必填：`eventId`（确定性稳定 ID）、`name`（事件名）、`timestamp`（ISO 8601 UTC）、`data`（符合 `payloadSchema`，单条完整 UTF-8 Webhook 信封 `<= 256 KiB`，用户内容标明不可信）；
- 游标位置：`poll` 放于结果顶层 `cursor`（不放在单条 occurrence 内）；`push` 与 `webhook` 放于 occurrence 可选 `cursor` 字段；
- **安全扫描前缀模型**：上游扫描区分“当前墙钟 `now`”与“已验证完整扫描的安全前缀 `safePrefix = min(lastCompleteScanEnd, now - configuredLagWindowMs)`”，通过边界重叠扫描 + 稳定去重避免 Bugzilla 事务提交/shadow DB 延迟导致漏单；不完整扫描绝不推进 `safePrefix`。

## 4. 核心行为契约（EARS & Parnas 决策表）

> 注：以下为 `C0` 冻结边界规范（仅约束外部可观测行为，不含内部实现细节），每条条款由 `spec_check.py stamp` 生成内容哈希 ID（`[R-xxxxxx]`），作为 `C1` 实现盲验证的唯一追踪锚点。

### 4.1 协议双代路由、安全隔离与凭据绑定

**双代分发与错误优先级（Parnas 决策表，自左向右按前置条件评估）**：

| 检查阶段 | 非法 `Origin`? | 路由/信封形态 | 协议版本受支持? | 镜像头(`MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`/`Mcp-Param-*`)完整且匹配? | 可观测结果 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Yes | Any | - | - | HTTP `403`（拒绝，零副作用） |
| 2 | No | 现代请求缺少必需 `_meta` 键 | - | - | HTTP `400` + JSON-RPC `-32602`（不降级到 legacy） |
| 3 | No | 现代请求带 `_meta` | No | - | HTTP `400` + JSON-RPC `-32022`（附 `data.supported` 与 `data.requested`） |
| 4 | No | 现代请求带 `_meta` | Yes | No（缺失/畸形/不匹配） | HTTP `400` + JSON-RPC `-32020`（`HeaderMismatch`，零副作用） |
| 5 | No | 现代请求带 `_meta` | Yes | Yes | 走无状态 `2026-07-28` 分发（仅使用当前请求声明的 `clientCapabilities`，所有成功结果带 `resultType`） |
| 6 | No | `initialize` 或已协商 legacy 会话 | `2025-11-25` | - | 走独立 legacy 会话语义（与并发现代无状态请求隔离） |

- [R-7c8831] WHEN a Streamable HTTP request arrives with an authorized or allowed absent `Origin` and valid `2026-07-28` `_meta` and mirror headers, the server SHALL dispatch it statelessly using only that request's declared `clientCapabilities` and return the method's specified result (with `resultType`) or error.
- [R-8e6163] WHEN a client sends a legacy `initialize` request for `2025-11-25`, the server SHALL isolate its negotiated session state per session without falling back malformed modern requests into legacy mode or disrupting concurrent `2026-07-28` callers.
- [R-d34daa] IF a Streamable HTTP request carries an unauthorized `Origin` header, THEN the server SHALL reject it with HTTP `403` and zero domain side effects.
- [R-1120b2] IF a modern Streamable HTTP request omits a required routing header (`MCP-Protocol-Version`, `Mcp-Method`, applicable `Mcp-Name`, or annotated `Mcp-Param-*`), supplies a malformed value, or mismatches the JSON-RPC body, THEN the server SHALL reject it with HTTP `400` and JSON-RPC `-32020` before any domain side effect.
- [R-be7235] IF a modern request declares an unsupported protocol version, THEN the server SHALL reject it with HTTP `400` and JSON-RPC `-32022` containing `data.supported` and `data.requested`.
- [R-669595] INVARIANT: Every `CacheableResult` (`server/discover`, `tools/list`, `resources/*`, `prompts/list`) whose content depends on an authenticated principal SHALL carry `cacheScope: "private"` and `ttlMs >= 0`, every server-side cache and lookup SHALL be partitioned by `(principal, instance, credentialGeneration)`, and the server SHALL NEVER forward an inbound MCP Bearer token to Bugzilla.
- [R-32f1fc] WHEN protected Bugzilla data is requested via `resources/read` or a read tool in `2026-07-28` mode, the server SHALL authorize under the current bound Bugzilla credential and return matching data on success, or return indistinguishable JSON-RPC `-32602` (never `-32002`, never empty `contents`, never leaking existence) when the resource does not exist or is unauthorized.
- [R-3b4d46] IF an authenticated cloud principal invokes a Bugzilla-backed tool without a bound API key, THEN the server SHALL NOT request the key via `elicitation` form mode; it SHALL return a `2026-07-28` URL elicitation `InputRequiredResult` (when `elicitation.url` is declared in the current request) bound to `(issuer, principal, clientId, instance, reqFingerprint)` or a structured `CredentialBindingRequired` error, and SHALL reject any bind or MRTR retry failing opener-identity, ticket, or single-use verification.
- [R-970164] INVARIANT: Every tenant-scoped server state record (receipts, proposals, drafts, internal notes, write audits, webhook subscriptions, event cursors, and cloud approval tokens) SHALL be partitioned by `(issuer, principalId, instanceUrl)` so two distinct OAuth issuers assigning the same `principalId` cannot read, collide with, replay, or approve each other's state.

### 4.2 分级写入门禁、幂等状态机与防循环（Parnas 决策表）

**前置校验顺序**（严格互斥）：① 当前 `principal` 鉴权与输入校验（含 `idempotencyKey` 非空及因果写入预算未耗尽）→ ② 查询按 `(principal, instance, operation)` 隔离的幂等记录状态 → ③ 分级门禁与审批核验 → ④ 执行前乐观检查与上游提交。

| 幂等记录状态 (`scope=(principal,instance,op)`) | 规范意图哈希匹配? | 写入级别 (`tier`) | `Safe-Auto` 私有写能力或 `Guarded` 有效授权/审批? | 执行前 `last_change_time` 匹配? | 上游写结果 | 可观测结果 (`Outcome`) | 上游副作用 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pending` / `indeterminate` | Yes | Any | - | - | - | `OperationPending` / `OperationIndeterminate`（禁止自动重发） | 0 |
| `applied` | Yes | Any | 当前仍有目标权限 | - | - | `DuplicateNoOp`（返回原 `artifactId`） | 0 |
| `applied` / `pending` / `indeterminate` | No | Any | - | - | - | `IdempotencyConflict` | 0 |
| `absent` / `failed` | - | `Safe-Auto` | 具备 `insidergroup` 私有写权限且 `isPrivate=true` | - | 成功 | `Applied`（记录写溯源 `commentId`） | 1 次私有写 |
| `absent` / `failed` | - | `Safe-Auto` | 缺 `insidergroup` 或被拒（绝不降级公评） | - | - | `SavedAsInternalNote`（仅写服务端内部笔记） | 0 公写 |
| `absent` / `failed` | - | `Guarded` | 无策略直通且无有效单次审批凭证 | - | - | `ProposalPending(proposalId, revision)` | 0 |
| `absent` / `failed` | - | `Guarded` | 有策略放行或有效单次审批（云端须服务端签名凭证；本地可信 IDE 宿主确认） | No | - | `StaleBugConflict`（附当前已授权最新快照，需建新提案版本） | 0 |
| `absent` / `failed` | - | `Guarded` | 同上 | Yes | 成功 | `Applied` + 写后差异审计记录（明示原生 REST 极小 TOCTOU 窗口） | 1 次写 |
| `absent` / `failed` | - | Any | 同上 | Yes / N/A | 响应超时/连接中断 | `OperationIndeterminate`（锁定该键待对账，禁止自动重试） | 0 或 1（未知） |

- [R-d31426] WHEN any mutating tool (`bugzilla_post_analysis`, `bugzilla_propose_update`, `bugzilla_create_bug`, `app_resolve_proposal`) executes, the server SHALL scope idempotency to `(principal, instance, operation)` and enforce the exact outcome and upstream mutation bounds of the Section 4.2 Parnas table.
- [R-68841d] WHEN an authorized caller replays an identical canonical intent whose receipt is `applied`, the server SHALL re-verify target access and return `DuplicateNoOp` with the original artifact ID; IF the receipt is `pending` or `indeterminate`, THEN the server SHALL return its stable pending/indeterminate receipt and perform zero additional upstream mutations.
- [R-e49910] IF a previously seen `idempotencyKey` within the same `(principal, instance, operation)` scope is reused with a different canonical intent, THEN the server SHALL reject the call with `IdempotencyConflict` and perform zero upstream writes.
- [R-80b183] INVARIANT: `bugzilla_post_analysis` (`Safe-Auto`) SHALL enforce `isPrivate: true` unconditionally; IF the bound Bugzilla user lacks private-comment permission or Bugzilla rejects private visibility, THEN the server SHALL fail closed to `SavedAsInternalNote` and SHALL perform zero public Bugzilla writes.
- [R-a722be] IF a `Guarded` mutation lacks an authorized policy grant or a valid single-use approval bound to `(approver, instance, proposalId, revision, canonicalDiffHash, baseVersion, visibility, exp)` (server-verified HTTPS approval in cloud mode; host-confirmed in local trusted IDE mode), THEN the server SHALL perform zero upstream mutations.
- [R-f5dc7f] WHEN a `Guarded` proposal is executed against a Bugzilla instance without atomic CAS, the server SHALL perform a pre-dispatch `last_change_time` check rejecting mismatches with `StaleBugConflict` (returning only currently authorized fields and requiring a new immutable proposal revision to rebase) and SHALL record a post-write diff audit entry on completion.
- [R-006bf9] WHILE `includeSelf` is `false` (default), the event synthesizer SHALL suppress only occurrences correlated to trusted durable write provenance `(instance, bugId, commentId/diffRecord)` and SHALL preserve eligible human occurrences that merely quote footer text or share a timestamp; independent of caller-supplied `idempotencyKey`, the server SHALL enforce a finite per-bug causal write budget for event-triggered action chains.

### 4.3 合成事件游标、重放、Webhook 安全与 MCP App 契约（Parnas 决策表）

**前置校验顺序**：① `principal` 鉴权与 `inputSchema` 校验 → ② 游标语法、作用域 `(instance, authView, canonicalFilter)` 与 `schemaEpoch` 校验 → ③ 扫描完整性与重放窗口判定。

| 游标状态 | 上游扫描完整? | 位于有效重放窗口且满足 `maxAgeMs` 下界? | 合格匹配事件数 vs `maxEvents`（仅 `poll`） | 交付模式 | 可观测结果与安全游标规则 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 畸形或异源作用域 | - | - | - | Any | 返回 `InvalidParams` |
| 语法有效但 `schemaEpoch` 过期 | - | - | - | Any | 返回 `Unsupported(reason: "schema_changed")` |
| `null` / 省略 | Yes | - | - | `poll` / `stream` / `webhook` | 零历史回放，锚定当前已提交安全前缀 `safePrefix`，返回非空 `cursor` 与 `truncated: false`（`stream` 先发 `active` 含 `heartbeatMs`） |
| 有效游标 | No（上游故障/未翻尽） | - | - | Any | 保持上一次已验证安全游标不前推；`poll` 报错或返回未推进状态，`stream` 发可恢复 `error` |
| 有效游标 | Yes | Yes | `0` | `poll` / `stream` / `webhook` | `poll` 返回空列表 + 推进至 `safePrefix` 的新 `cursor` + `nextPollMs`；`stream` 借 `heartbeat` 推进游标；`webhook` 刷新返回推进游标 |
| 有效游标 | Yes | Yes | `1..maxEvents`（或流/Webhook 实时） | `poll` / `stream` / `webhook` | 逐条重验可见性后按序交付；`poll` `hasMore: false`, `truncated: false` |
| 有效游标 | Yes | Yes | `> maxEvents` | `poll` | 返回前 `maxEvents` 条、`hasMore: true`、`truncated: false` 与严格落在当前页尾的中间 `cursor` |
| 有效游标 | Yes | No（超出窗口或被 `maxAgeMs` 截断） | Any | `poll` / `stream` / `webhook` | 重置至有效窗口下界并显式标示 `truncated: true`（`stream` 发 `active(truncated: true)`；SEP Webhook 发已签名 `gap` 控制帧） |

- [R-08abaf] WHEN `events/poll`, `events/stream`, or `events/subscribe` is called with `cursor: null` (or omitted), the server SHALL return zero historical occurrences and anchor a fresh non-null cursor at the current committed `safePrefix` (never ahead of the configured bounded-lag safety margin).
- [R-d7d0a2] WHEN an event delivery request carries a cursor, the server SHALL enforce the Section 4.3 Parnas table: rejecting malformed/foreign cursors with `InvalidParams` and obsolete schema epochs with `Unsupported`, keeping the safe resume position at or before the last verified complete scan prefix whenever a scan is incomplete, advancing quiet cursors only to a verified complete `safePrefix`, and emitting every retained eligible occurrence strictly after the cursor boundary with distinct deterministic `eventId` values.
- [R-f03918] INVARIANT: Before releasing any occurrence on `poll`, `stream`, `webhook`, or webhook retry, the server SHALL verify current visibility under the bound Bugzilla credential and fail closed (suppressing restricted/deleted objects without leaking IDs or counts); IF the credential or subscribed scope is revoked, THEN the server SHALL stop delivery and emit the profile-specific termination signal (`notifications/events/terminated` / `Forbidden` / SEP signed `terminated` envelope, never sending unsupported control envelopes under ChatGPT profile).
- [R-28f5c2] INVARIANT: On every outbound webhook HTTP connection (initial verification challenge, event delivery, retry, and control envelope), the server SHALL enforce HTTPS, connection-time validation of all normalized resolved IPs (blocking non-public/IPv4-mapped private addresses), IP-pinned dialing with preserved `Host` and TLS SNI, and disabled redirects.
- [R-82de80] WHEN delivering webhook events under SEP-3415 profile, the server SHALL generate a unique high-entropy `webhook-id` independent of `eventId` (reused across retries with refreshed `webhook-timestamp` and `v1,` HMAC-SHA256 over `webhook-id.webhook-timestamp.rawBody`), include `X-MCP-Subscription-Id`, cap serialized UTF-8 envelopes at `<= 256 KiB`, stop retrying on `410` or `413`, and hold the safe client watermark behind unresolved deliveries or persist an explicit `gap`/`truncated: true` signal across restarts.
- [R-cd4f75] WHERE `eventsProfile: "chatgpt-events"` is configured before discovery, the server SHALL advertise top-level `capabilities.events`, restrict `delivery` to `["webhook"]`, set `webhook-id = eventId`, accept `delivery.mode: "webhook"` with idempotent empty `{}` on `events/unsubscribe`, return `-32015` on callback failure, and expose lost-history recovery via `truncated: true` on refresh without sending unsupported `gap`/`terminated` bodies.
- [R-81d5f2] WHEN the same authenticated principal refreshes a webhook subscription with canonical-JSON-equivalent `arguments`, the server SHALL preserve one subscription identity, dual-sign during secret rotation windows, and persist long-lived/no-expiry grants and verification status across restarts.
- [R-3d5465] WHEN rendering Bugzilla text or invoking `app.sendMessage()` / `app.updateModelContext()` in the MCP App, the UI SHALL render Bugzilla fields as inert data (preventing XSS) and SHALL exclude untrusted Bugzilla titles, comments, filenames, and conflict snapshots from user-role `sendMessage` instruction text.
- [R-316609] WHEN `app_save_draft` acknowledges a revision for `(principal, instance, bugId, draftKind)`, the server SHALL persist that acknowledged revision across view replacement and restart and SHALL reject older `draftRevision` writes from overwriting it.

## 5. 已决技术边界记录（C0 v2 红队修订冻结）

| 决策项 | 确认结论 | 影响范围 |
| :--- | :--- | :--- |
| 防死循环与因果预算 | 仅依据可信持久化写溯源 `(instance, bugId, commentId/diffRecord)` 过滤（绝不凭尾注文本或同秒时间戳误杀真人事件），叠加不依赖模型传参的服务端因果写入预算 | `core/guard`、`core/events`、`storage` |
| Guarded 并发冲突（原生无 CAS） | 诚实分层：执行前做 `last_change_time` 乐观校验（不匹配拒为 `StaleBugConflict` 并要求创建新提案版本）+ 写后差异审计（明示原生 REST 极小 TOCTOU 窗口），高敏操作支持一键跳转 Bugzilla 网页 | `core/guard`、`app-ui` |
| Guarded 审批信任边界 | 云端多用户模式要求服务端独立 HTTPS `/approve` 页面签发单次签名审批凭证（不信任 `visibility: ["app"]`）；本地可信 IDE 模式允许经宿主 MCP App 确认并在契约明示边界差异 | `server`、`core/guard`、`app-ui` |
| Safe-Auto 私有写红线 | `isPrivate: true` 不可降级；用户无 `insidergroup` 权限时 Fail-Closed 落为服务端内部笔记（零公写） | `core/guard`、`bugzilla-client` |
| v1 存储后端策略 | `storage/ports` + Drizzle 统一 Schema；v1 先落地 SQLite 适配器（本地 + 单机云端），Phase 2 扩展 PostgreSQL 适配器 | `packages/storage` |
| 形式化验证策略 | 针对“合成事件摄入与交付”和“写入门禁与提案生命周期”两个核心状态机补充精简 Quint (`.qnt`) 模型，用于验证多步不变量并指导 `C1` 实现盲验证 | `specs/*.qnt` |
