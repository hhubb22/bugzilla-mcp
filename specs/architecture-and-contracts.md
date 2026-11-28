# Bugzilla Frontier MCP Server: 架构与契约规范

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

### 3.1 面向模型的 Tools（7 个，均声明单源生成的 JSON Schema 2020-12 `inputSchema` + `outputSchema` + 标准 `ToolAnnotations`）

> `ToolAnnotations` 严格使用 MCP `2026-07-28` Schema 字段名（`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`）。全部 11 个工具（7 个模型工具 + 4 个 App-only 工具）的 `inputSchema` 与 `outputSchema` 均由 `packages/contracts` 单一注册表编译生成，杜绝手写漂移；`outputSchema` 仅约束非错误成功响应，工具执行期的可恢复错误通过 `CallToolResult { isError: true }` 返回（同时在 `content[0].text` 与 `structuredContent` 提供完整可操作信息，见第 4.2 节）。为避免租户/私有缺陷信息通过 `Mcp-Param-*` 暴露给中间代理，**默认不把 `bugId` 或敏感 `product` 标为 `x-mcp-header`**（仅在部署策略显式声明为公开非敏感键时启用）。

| Tool Name | `ToolAnnotations` | UI 表面绑定 | 核心入参 / 出参契约 |
| :--- | :--- | :--- | :--- |
| `bugzilla_search` | `readOnlyHint: true`, `idempotentHint: true` | 无 | 入参：`product?`, `component?`, `status[]?`, `assignedTo?`, `updatedSince?`, `query?`, `limit(<=50)`, `offset`<br>出参：`{ items: BugSummary[], nextOffset?, totalHint? }`（严格字段投影，无正文/附件） |
| `bugzilla_get_dossier` | `readOnlyHint: true`, `idempotentHint: true` | **仅 Inline**（`ui://bugzilla/dossier-card.html`，不声明 `aux_pane`） | 入参：`bugId`, `maxComments(default 15)`, `maxHistory(default 30)`<br>出参：`BugDossier`（核心字段 + 精简流转 + 近期评论 + 附件元数据 + 服务端内部笔记，剥离 Base64 `data`，完整序列化 `<= 128 KiB`） |
| `bugzilla_triage_board` | `readOnlyHint: true`, `idempotentHint: true` | **`aux_pane` + `global`**（`ui://bugzilla/triage-app.html`，带类型化 entrypoint 对象；无 UI 宿主回退文本摘要） | 入参全可选（空 `{}` 返回当前用户“待审提案 / Needinfo / 我负责”默认队列，完整序列化 `<= 128 KiB`） |
| `bugzilla_post_analysis` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` *(上游无原生幂等键，由网关状态机保障)* | 无 | **Safe-Auto（私有不可降级）**：`isPrivate` 恒为 `true`（拒绝公评入参）；用户有 `insidergroup` 权限则写 Bugzilla 私有评论，无权限或 Bugzilla 私有评论权限拒写则 **Fail-Closed 落为服务端内部笔记（零公写，仍计入因果预算）**；确定性 4xx/401/403/429 非写拒绝返回 `upstream_rejected`（不锁死幂等键）；必填 `idempotencyKey`；返回 `applied \| saved_as_internal_note \| duplicate_noop \| upstream_rejected \| indeterminate` |
| `bugzilla_propose_update` | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false` | 无 | **Guarded-Write**：变更 `status`/`resolution`/`dupeOf`/`assignedTo`/`priority`/`flags`（支持 `id`/`typeId`/`new`）/公开评论；`ProposalDiff` 采用严格模式（`additionalProperties: false` 拒绝未知/snake_case 键、`minProperties: 1` 拒绝空 `{}`、`status: "RESOLVED"` 必带 `resolution`、`resolution: "DUPLICATE"` 必带 `dupeOf`）；必填 `idempotencyKey` 与 `expectedLastChangeTime`；默认创建不可变 `ProposalPending(proposalId, revision)`；仅在具备有效策略放行或独立审批凭证时执行“执行前乐观检查 + 写后差异审计”。仅含评论的 Guarded 更新路由至 `POST /bug/{id}/comment` 以获取确定性 `commentId` 写入 `[R-5d5271]` 自写溯源；字段与评论混合更新保持单次 `PUT /bug/{id}` 原子性 |
| `bugzilla_create_bug` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` | 无 | 必填 `idempotencyKey`、`summary`、`product`、`component`、`version` 与发布策略级别（同时暴露可选 `opSys`、`platform`、`assignedTo`、`targetMilestone`、`cc`、`groups`、`keywords` 及键名严格匹配 `/^cf_[a-z0-9_]+$/` 的 `customFields`）。**预检（Preflight）+ 惰性元数据**：在预留幂等记录与调用 `POST /rest/bug` 之前，基于按 `(issuer, principalId, instanceUrl, credentialGeneration)` 私有缓存的惰性实例元数据（优先仅拉取可录入产品名或按 `product` 惰性查询 `/rest/product/{name}`，避免大型实例多 MiB 膨胀，并按实例合法枚举解析 `op_sys`/`platform` 默认值）校验必填项；缺失必填字段或实例约束不满足时，若现代请求声明 `elicitation.form` 且启用表单续传则返回 `InputRequiredResult` 动态表单，否则返回 `isError: true` 的 `UpstreamRejected`（附 `missingFields` 与有界候选提示，零幂等键/预算消耗） |
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

部署在启动前选择 `eventsProfile: "sep-3415" | "chatgpt-events"`。可声明的能力和交付方式见第 4.3 节。实时推送不在本次交付范围：不声明 `push`，也不接受 `events/stream`。本地仍可用 SEP 的 `poll`。

每个目录项声明 `inputSchema` 和 `payloadSchema`。所有事件的 `includeSelf` 都是可选布尔值，省略时为 `false`。以下条件均为可选，已提供的条件必须同时满足：

| 事件 | 除 `includeSelf` 外支持的条件 |
| :--- | :--- |
| `bugzilla.bug.created` | `product`、`component`、`severity`。`severity` 匹配采集该条事件时工单的 `severity`，不是创建时的历史值。重试沿用采集结果。 |
| `bugzilla.bug.updated` | `product`、`bugIds`、`watchedFields`。`watchedFields` 允许 `status`、`assigned_to`、`priority`、`flags`。 |
| `bugzilla.bug.commented` | `product`、`bugIds`、`mentionMe`。 |
| `bugzilla.flag.needinfo` | `product`、`requestee`。`requestee` 接受 `me` 或指定用户。 |

**完整事件发生体（`EventOccurrence`）**：
- 必填：`eventId`（确定性稳定 ID）、`name`（事件名）、`timestamp`（ISO 8601 UTC）、`data`（符合 `payloadSchema`，单条完整 UTF-8 Webhook 信封 `<= 256 KiB`，用户内容标明不可信）；
- `poll` 的游标位于结果顶层。Webhook 事件可包含用于恢复的 `cursor`。
- `safePrefix` 是最新一次完整扫描已验证的连续位置，不晚于该次扫描采用的 `now - configuredLagWindowMs`。扫描必须读取覆盖该位置的所有候选页及所需历史和评论。分页未完成或读取失败不产生新的 `safePrefix`。滞后窗口只覆盖窗口内的上游迟到数据。

## 4. 核心行为契约（EARS & Parnas 决策表）

> `spec_check.py stamp` 为每条行为生成内容哈希 ID（`[R-xxxxxx]`）。C0 签核后冻结条款，C1 使用这些 ID 追踪外部行为。

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

**前置校验顺序**（严格互斥）：① 当前 `principal` 鉴权与输入校验（含 `idempotencyKey` 非空、因果写入预算检查及 `bugzilla_create_bug` 惰性元数据预检——均在预留幂等记录前完成，零持久副作用）→ ② 查询并按 `leaseToken` CAS 预留 `(principal, instance, operation)` 隔离的幂等记录（仅允许在 `absent`、`failed` 或**已过期且 `dispatchAttempted === false`** 的 `pending` 记录上分配全新 `leaseToken` 抢占，消除 Stage 2 崩溃导致的永久 `OperationPending` 悬挂）→ ③ 分级门禁、审批核验（Stage 1/2 仅验签不消费 JTI）与执行前 `last_change_time` 乐观检查 → ④ Stage 3 提交阈值围栏（CAS 校验 `status = 'pending' AND lease_token = ?` 后持久化 `markDispatchStarted`、消费单次 JTI、扣减因果预算，然后执行单次不可中断的上游写请求）→ ⑤ Stage 4 写后原子本地提交（独立于 `indeterminate` 异常捕获；上游已 2xx 确认后即使本地审计/后置读失败也绝不从 `Applied` 回退到 `Pending`/`Indeterminate`）。

> **租约围栏与路由细节**：
> - 一旦 `markDispatchStarted` 将 `dispatchAttempted` 置为 `true`，租约过期只允许转为 `indeterminate` 而严禁被其他工作协程回收重发；过期/被抢占的旧协程携带旧 `leaseToken` 执行任意状态推进时均被 CAS 围栏拦截（零上游写）。
> - 仅含评论（comment-only）的 `Guarded` 更新路由至 `POST /bug/{id}/comment` 以获取确定性 `commentId` 记录 `[R-5d5271]` 自写溯源；字段与评论混合更新保持单次 `PUT /bug/{id}` 原子性。

| 幂等记录状态 (`scope=(principal,instance,op)`) | 规范意图哈希匹配? | 写入级别 (`tier`) | `Safe-Auto` 私有写能力或 `Guarded` 有效授权/审批? | 执行前 `last_change_time` 匹配? | 上游写结果 | 可观测结果 (`Outcome`) | 上游副作用 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pending`（未过期或 `dispatchAttempted=true`） / `indeterminate` | Yes | Any | - | - | - | `OperationPending` / `OperationIndeterminate`（禁止自动重发） | 0 |
| `applied` | Yes | Any | 当前仍有目标权限 | - | - | `DuplicateNoOp`（返回原 `artifactId`） | 0 |
| `applied` / `pending`（未过期或已派发） / `indeterminate` | No | Any | - | - | - | `IdempotencyConflict` | 0 |
| `absent` / `failed` / `pending`（已过期且 `dispatchAttempted=false`，新 `leaseToken` CAS 抢占） | - | `Safe-Auto` | 具备 `insidergroup` 私有写权限且 `isPrivate=true` | - | 成功 | `Applied`（记录写溯源 `commentId`） | 1 次私有写 |
| `absent` / `failed` / 可回收 `pending` | - | `Safe-Auto` | 缺 `insidergroup` 或 Bugzilla 私有评论权限拒写（绝不降级公评） | - | - | `SavedAsInternalNote`（仅写服务端内部笔记，仍计入因果预算） | 0 公写 |
| `absent` / `failed` / 可回收 `pending` | - | `Guarded` | 无策略直通且无有效单次审批凭证 | - | - | `ProposalPending(proposalId, revision)` | 0 |
| `absent` / `failed` / 可回收 `pending` | - | `Guarded` | 人工通过 `app_resolve_proposal(decision: "reject")` 驳回提案 | - | - | `ProposalRejected(proposalId, revision, rejectedAt)`（独立于 `Applied`） | 0 |
| `absent` / `failed` / 可回收 `pending` | - | `Guarded` | 有策略放行或有效单次审批（云端须服务端签名凭证；本地可信 IDE 宿主确认） | No | - | `StaleBugConflict`（收据回写 `failed`，附当前已授权最新快照，需建新提案版本） | 0 |
| `absent` / `failed` / 可回收 `pending` | - | Any | 同上（或预检/校验阶段） | Yes / N/A | 确定未写入（4xx 校验拒绝 / `401` / `403` / `429`，`effectCertainty: "none"`） | `UpstreamRejected`（`leaseToken` CAS 回写收据 `failed`，提案 `executing -> pending`，退回本次因果预算，附 `bzErrorCode`/`missingFields`/`remediationHint`，不锁死幂等键） | 0 |
| `absent` / `failed` / 可回收 `pending` | - | `Guarded` | 同上 | Yes | 成功 | `Applied` + 写后差异审计记录（仅评论更新走 `POST /bug/{id}/comment`；混合更新走 `PUT /bug/{id}` 并明示原生 REST 极小 TOCTOU 窗口；写后本地错误不回退 `Applied`） | 1 次写 |
| `absent` / `failed` / 可回收 `pending` | - | Any | 同上 | Yes / N/A | 响应超时 / 连接中断 / 5xx / 派发后租约过期（`effectCertainty: "uncertain"`） | `OperationIndeterminate`（锁定该键待对账，提案置为 `indeterminate`，禁止自动重试） | 0 或 1（未知） |

**`tools/call` 错误通道边界（`CallToolResult { isError: true }` vs JSON-RPC Error）**：
- **工具执行期可恢复错误 → `CallToolResult { isError: true, content, structuredContent }`**（必须在 `content[0].text` 输出完整可读细节以兼容忽略 `structuredContent` 的客户端，且不受成功态 `outputSchema` 排斥）：`InvalidToolInput`（附结构化 `issues`）、`UpstreamRejected`、`StaleBugConflict`、`IdempotencyConflict`、`OperationPending`、`OperationIndeterminate`、`CausalBudgetExhausted`、`CredentialRevoked`、`CredentialBindingRequired`（无 MRTR `elicitation.url` 时的回退）、`UnsupportedAttachment`。
- **协议 / 路由 / 安全硬边界错误 → JSON-RPC Error**（并保留 `error.data`）：未知工具或 `config.readOnly: true` 拒绝写入工具（`-32602`，`[R-0b14d8]`）、受保护资源不可区分拒绝（`-32602`，`[R-32f1fc]`）、现代请求镜像头/协议版本错误（`-32020`/`-32022`）、以及仅限于 `events/*` 域的 SEP/Events 错误码（`-32024..-32027`，严禁复用于写入工具或 `stdio` 鉴权错误）。

- [R-d31426] WHEN any mutating tool (`bugzilla_post_analysis`, `bugzilla_propose_update`, `bugzilla_create_bug`, `app_resolve_proposal`) executes, the server SHALL scope idempotency to `(principal, instance, operation)` and enforce the exact outcome and upstream mutation bounds of the Section 4.2 Parnas table.
- [R-68841d] WHEN an authorized caller replays an identical canonical intent whose receipt is `applied`, the server SHALL re-verify target access and return `DuplicateNoOp` with the original artifact ID; IF the receipt is `pending` or `indeterminate`, THEN the server SHALL return its stable pending/indeterminate receipt and perform zero additional upstream mutations.
- [R-e49910] IF a previously seen `idempotencyKey` within the same `(principal, instance, operation)` scope is reused with a different canonical intent, THEN the server SHALL reject the call with `IdempotencyConflict` and perform zero upstream writes.
- [R-80b183] INVARIANT: `bugzilla_post_analysis` (`Safe-Auto`) SHALL enforce `isPrivate: true` unconditionally; IF the bound Bugzilla user lacks private-comment permission or Bugzilla rejects private visibility, THEN the server SHALL fail closed to `SavedAsInternalNote` and SHALL perform zero public Bugzilla writes.
- [R-a722be] IF a `Guarded` mutation lacks an authorized policy grant or a valid single-use approval bound to `(approver, instance, proposalId, revision, canonicalDiffHash, baseVersion, visibility, exp)` (server-verified HTTPS approval in cloud mode; host-confirmed in local trusted IDE mode), THEN the server SHALL perform zero upstream mutations.
- [R-f5dc7f] WHEN a `Guarded` proposal is executed against a Bugzilla instance without atomic CAS, the server SHALL perform a pre-dispatch `last_change_time` check rejecting mismatches with `StaleBugConflict` (returning only currently authorized fields and requiring a new immutable proposal revision to rebase) and SHALL record a post-write diff audit entry on completion.
- [R-5d5271] WHEN the server selects an otherwise eligible occurrence, the server SHALL omit it if and only if `includeSelf` is `false` and the same tenant's durable provenance uniquely identifies the occurrence as one of the server's writes.
- [R-462339] WHERE event-triggered writes are authorized, the server SHALL enforce a finite per-bug causal write budget independent of the caller-supplied `idempotencyKey`.

可信归因包括创建时 Bugzilla 返回的工单 ID、评论时返回的评论 ID，以及字段更新时 Bugzilla 确认的字段旧值和新值与历史记录的一对一对应。由同一条历史记录派生的 `needinfo` 事件沿用该记录的归因。不能证明对应关系时，归因为未知。请求意图哈希、账号、工单和时间戳的组合或评论文本都不能单独证明归因。

### 4.3 Events 能力声明和订阅

HTTP 请求先通过第 4.1 节的路由、会话和鉴权检查，再按下表分发。`startMcpHttpServer` 的 `config.webhookEnabled` 默认 `false`。只能在有身份认证的 HTTP 端点启用。启用要求可用的 HTTPS 发送器、重启可恢复的订阅和投递存储、可取回的当前租户绑定，以及随服务启停的投递循环。项目提供生产用的 HTTPS 发送器和投递循环，部署方不必自写发送器或另启循环。

| 配置及前置条件 | 能力与目录 | 禁用方法的结果 |
| :--- | :--- | :--- |
| 启用 Webhook，任一条件不满足 | 启动失败，错误 `code: "WebhookConfigurationError"`，不开放 HTTP 端点 | 不适用 |
| `chatgpt-events`，Webhook 未启用 | 不声明 `capabilities.events` | `events/*` 返回 `-32601` |
| `chatgpt-events`，Webhook 已启用 | 两代 HTTP 均声明 `capabilities.events`。目录只列 `webhook`。 | `events/poll`、`events/stream` 返回 `-32601` |
| `sep-3415`，Webhook 未启用 | SEP 协商入口声明 `capabilities.extensions["io.modelcontextprotocol/events"]`。目录只列 `poll`。 | `events/stream`、Webhook 订阅方法返回 `-32026`，`data.reason: "delivery_disabled"` |
| `sep-3415`，Webhook 已启用 | 同上。目录列 `poll` 和 `webhook`。 | `events/stream` 返回 `-32026`，`data.reason: "delivery_disabled"` |

两个配置都接受 `events/subscribe` 的 `delivery: { mode: "webhook", url, secret }`。取消订阅时，ChatGPT 使用 `delivery: { mode: "webhook", url }`，SEP 使用 `delivery: { url }`。客户端不传订阅 `id`。现代 HTTP 成功结果包含 `resultType: "complete"`，旧版成功结果不含 `resultType`。

- [R-48f15c] WHEN the operator starts the HTTP server, the server SHALL enforce the Section 4.3 readiness table and, on a successful Webhook-enabled start, SHALL verify subscriptions and deliver eligible events without an additional operator command.
- [R-9b9b89] WHERE `chatgpt-events` is enabled on authenticated HTTP, the server SHALL support `events/list`, `events/subscribe`, and `events/unsubscribe` on both the negotiated `2025-11-25` session and the stateless `2026-07-28` route, with the same tenant-scoped behavior and the result envelope for each revision.
- [R-e3c811] WHEN a validly routed request uses a disabled Events method, the server SHALL return the outcome in the Section 4.3 readiness table and SHALL perform no scan, callback, or subscription change.
- [R-0986c6] WHEN `events/list` describes an event, the server SHALL declare the per-event arguments in Section 3.4 with `additionalProperties: false`, and every enabled delivery method SHALL reject unknown or ill-typed arguments with `-32602` before scanning or changing a subscription.
- [R-8f1277] WHILE a `bugzilla.bug.created` request specifies `severity`, the server SHALL deliver every otherwise eligible occurrence whose Bugzilla severity at collection exactly equals the requested value and none whose severity differs or is unavailable.
- [R-0b14d8] WHERE the HTTP triage connector is configured with `config.readOnly: true`, the server SHALL continue to serve authorized reads, list only read tools, and reject direct calls to mutating tools with `-32602` before any side effect.

`readOnly` 默认 `false`。实际宿主验收使用启用 `readOnly` 的连接，不依赖提示词约束写入。未启用该选项的连接仍遵循第 4.2 节。

### 4.4 扫描、重放与 Webhook 投递

按以下顺序判断：先验鉴权和入参，再验游标的租户、可见范围、事件名、规范化参数与 `schemaEpoch`。新一轮重放的下界不早于服务端保留窗口和 `now - maxAgeMs`（如有）。重验当前事件可见性后才计算返回的合格事件。

| 游标与扫描状态（按顺序匹配） | `events/poll` | Webhook 订阅或刷新 |
| :--- | :--- | :--- |
| 游标畸形或作用域不匹配 | `InvalidParams` | 同左 |
| 游标的 `schemaEpoch` 已过期 | `Unsupported`，`data.reason: "schema_changed"` | 同左 |
| 刷新同一个仍有效的 Webhook 订阅 | 不适用 | 返回下文定义的安全游标和缺口状态。刷新本身不重扫、不重置待投递状态，也不按 `maxAgeMs` 丢弃待投递项。 |
| 游标为 `null` 或省略，已有可用的 `safePrefix` | 锚定 `safePrefix`。`events: []`、`hasMore: false`、`truncated: false`。 | 新订阅从 `safePrefix` 开始，返回该游标和 `truncated: false`。 |
| 用于这次求取新位置的扫描未完成 | JSON-RPC `-32603`，`data.reason: "scan_incomplete"`。无结果或新游标。 | 新订阅返回同样的错误，不建立订阅。 |
| 完整扫描，且有效游标不早于重放下界 | 批次按位置排序。还有合格项时返回 `maxEvents` 条、页尾游标、`hasMore: true`；否则返回所有合格项（可为空）、`safePrefix` 游标、`hasMore: false`。`truncated: false`。 | 补送游标后的合格事件。返回安全游标和 `truncated: false`。 |
| 完整扫描，且有效游标早于重放下界 | 从下界开始，继续遵循批次规则。`truncated: true`。 | 从可重放的下界补送，返回恢复游标和 `truncated: true`。 |

首次请求没有可用的 `safePrefix` 时，先扫描再锚定。扫描故障消除后，客户端可用原游标继续。已独立确认可交付的 Webhook 项仍可投递，不依赖失败的扫描。运维状态按授权和扫描的优先顺序报告：`authorization_revoked`、`scan_incomplete`、完整扫描无合格项时的 `idle`，或有合格项时的 `active`。

- [R-1006f2] WHEN `events/poll` or `events/subscribe` receives `cursor: null` or no cursor, the server SHALL return the initial-anchor or refresh outcome in the Section 4.4 cursor table without replaying before the new subscription's `safePrefix`.
- [R-c83005] WHEN an Events request supplies a non-null cursor, the server SHALL enforce the Section 4.4 cursor table and, for a poll or new replay, select every retained eligible occurrence after the effective boundary with a stable, distinct `eventId`.
- [R-a36d59] IF the scan required by `events/poll` cannot establish a complete prefix, THEN the server SHALL return `-32603` with `data.reason: "scan_incomplete"` and no partial batch or replacement cursor.
- [R-39bcf8] IF a Webhook scan cannot establish a complete prefix, THEN the failed scan SHALL neither advance acquisition nor create a history gap, and a later complete scan SHALL resume from the previous verified position.
- [R-b9935c] WHEN a Webhook subscription is first evaluated or changes scan or authorization state, the HTTP server SHALL write one UTF-8 JSON object per record to the process's `stderr`, followed by a newline, with `event: "mcp.events.scan"`, the opaque `subscriptionId`, and `state: "idle" | "active" | "scan_incomplete" | "authorization_revoked"` without credentials, callback addresses, or bug data.
- [R-cad0d6] INVARIANT: Before releasing any occurrence on `poll` or Webhook, including retry, the server SHALL verify current visibility under the tenant's bound Bugzilla credential, suppress restricted or deleted data without leaking identifiers or counts, and stop delivery on credential or scope revocation with `Forbidden` for poll or refresh and a signed `terminated` envelope only for SEP Webhook.
- [R-28f5c2] INVARIANT: On every outbound webhook HTTP connection (initial verification challenge, event delivery, retry, and control envelope), the server SHALL enforce HTTPS, connection-time validation of all normalized resolved IPs (blocking non-public/IPv4-mapped private addresses), IP-pinned dialing with preserved `Host` and TLS SNI, and disabled redirects.

| 已到发送时间时的结果（按顺序匹配） | 当前投递的结果 |
| :--- | :--- |
| 当前工单或评论不可见 | 不发事件，不标记缺口。订阅授权撤销时停止该订阅的所有事件投递。 |
| 回调返回 `2xx` | 确认收件，不再发送该投递。 |
| 回调返回 `410` 或 `413` | 结束该投递，不再重试。不取消订阅。 |
| 超时、网络错误、进程中断导致结果未知，或其余非 `2xx`，仍有额度 | 等待持久保存的退避时间，保留相同消息 ID。 |
| 同上，额度耗尽 | 结束该投递，并持久记录缺口。 |

`maxWebhookRetries` 为非负整数，默认 `3`，不含首次发送。已开始但结果未知的尝试占用一次额度。第 `k` 次重试最早在前次失败后 `min(10000, 1000 * 2**(k-1))` 毫秒发送。调度可以更晚。服务重启和同一订阅的刷新不重置尝试次数、最早重试时间或消息 ID。新匹配事件按事件位置安排首次发送，不保证实际抵达顺序。

`410`、`413` 或预算耗尽结束的是该订阅下的自动投递，不删除 Bugzilla 源记录。订阅再也不能补送时记录缺口。普通事件附带的游标不得越过未确认的投递或尚未告知客户端的缺口。SEP 在两次刷新之间发送带新游标的签名 `gap`；未获确认时，仍可在刷新中报告。ChatGPT 只在刷新中报告 `truncated: true` 和恢复游标。带旧游标刷新时，只要恢复游标越过缺口，响应就必须标记缺口，不能因重启或刷新响应丢失而省略。恢复游标不能跨过其他待投递项。

Webhook 使用 `Content-Type: application/json`。首次验证请求为 `{"type":"verification","challenge":"<nonce>"}`，成功回调以 `{"challenge":"<nonce>"}` 应答。验证使用唯一的消息 ID 和一次性 challenge。

- [R-cae32c] WHEN an authorized subscription targets a callback not yet verified for that tenant, the server SHALL send a fresh signed verification challenge and activate delivery only after the callback returns `2xx` and the JSON `challenge` matches exactly.
- [R-cebf76] WHEN a Webhook attempt completes or is interrupted, the server SHALL enforce the Section 4.4 delivery table and its retry deadlines and budget across restart and refresh.
- [R-836a57] WHEN a Webhook response or event exposes a resumable cursor, the server SHALL enforce the Section 4.4 watermark and gap rules without silently advancing past a pending or abandoned delivery.
- [R-79300a] WHEN sending a Webhook envelope, the server SHALL cap the UTF-8 body at `256 KiB`, include `X-MCP-Subscription-Id`, and sign `webhook-id.webhook-timestamp.rawBody` with Standard Webhooks `v1,` HMAC-SHA256 using the same `webhook-id` and a current timestamp on retry.
- [R-100db5] WHERE SEP Webhook is enabled, the server SHALL use an independent high-entropy `webhook-id` for each event delivery and return `-32027` when callback verification fails.
- [R-3be334] WHERE ChatGPT Webhook is enabled, the server SHALL use `webhook-id = eventId` for event delivery and return `-32015` when callback verification fails, without sending `gap` or `terminated` bodies.
- [R-81b530] WHEN a principal refreshes a subscription using the same callback URL, event name, and canonical arguments, the server SHALL retain that tenant's subscription identity, dual-sign during the secret rotation window, and preserve granted lifetimes and verification status across restarts.
- [R-9f1561] WHEN a principal calls `events/unsubscribe` with the original name, canonical arguments, and callback URL, the server SHALL stop further sends for only that principal's matching subscription and return an idempotent success (`{}` in legacy or `{"resultType":"complete"}` in modern HTTP).

### 4.5 MCP App 契约

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
