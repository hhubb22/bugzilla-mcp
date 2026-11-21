# Framing Brief: 自建 Bugzilla 前沿 MCP Server

- **Domain(s)**: `Product Positioning & Scope` · `Agent Workflow & Protocol UX`
- **Core Intent**: 面向自建 Bugzilla（5.0/5.2+）研发团队的 TypeScript 双模（云端自主值守 + 本地人机协同）缺陷自治网关。
- **Anchors / Baselines**:
  - 交互锚点：Linear Triage Inbox 信息密度；Sentry / GitHub Actions 事件驱动与幂等防循环护栏。
  - 协议基线：MCP Core `2026-07-28`（Dual-Era 兼容 `2025-11-25`）、MCP Apps（SEP-1865）、MCP Events（SEP-3415 + ChatGPT Dialect Adapter）。

## Explicit Non-Goals
- 不做 Bugzilla 管理员配置（Product/Component/Group/User 的管理端 CRUD）。
- 不修改自建 Bugzilla 源码或强依赖自定义 Perl 插件（v1 坚持纯 REST API 零侵入接入）。
- 不做重型 BI 报表、燃尽图或跨季度统计大盘。
- 不做 Bugzilla 数据库全量离线镜像或二进制附件在线编辑器。

## Adopted Domain Primitives & Anti-Patterns
- **Dossier-First Read**: 提供聚合式缺陷档案（精简字段 + 关键历史 + 近期评论 + 附件元数据，剥离 Base64），避免多轮碎片查询。
- **Self-Hosted Dialect Introspection**: 动态内省 `/rest/field/bug` 与 `/rest/product`（含 `cf_*` 自定义字段与合法状态流），用真实实例 Schema 驱动校验与表单。
- **Synthetic Event Bus + Anti-Loop Guard**: 基于 `last_change_time` + `/history` + `/comment?new_since=` 合成**有界延迟可重放事件流**（扫描安全前缀与墙钟时间解耦，放行前逐条重验权限），并内置服务端写溯源过滤与独立于模型参数的因果写入预算（Causal Write Budget）。
- **Tiered Write Autonomy**: 写操作明确划分为 **Safe-Auto**（强制 `is_private: true` 不可降级；无 `insidergroup` 权限时 Fail-Closed 落为服务端内部笔记，零公写）与 **Guarded-Write**（原生 Bugzilla 无原子 CAS，承诺“执行前乐观检查 + 写后差异审计”并明示极小 TOCTOU 窗口；云端要求服务端独立核验真人审批，本地可信 IDE 允许 MCP App 直接确认）。
- **Single Core, Dual Surface**: 一套 TS 业务内核服务云端（Streamable HTTP + OAuth 2.1/CIMD + Webhook/Poll）与本地（stdio/HTTP + MCP Apps + Stream）。
- **Private-by-Default Boundary**: 含鉴权可见范围的资源/列表严格标为 `cacheScope: "private"`，敏感字段禁入路由头，订阅定期重验权限。
- **Avoid (REST 1:1 裸套壳)**: 禁止把 30+ 个裸接口直接暴露成模型工具。
- **Avoid (无护栏自主写入)**: 禁止在无幂等键与自身事件过滤的情况下放开事件触发写回。
- **Avoid (表单收集凭据)**: 禁止用 MCP `form` Elicitation 收集 Bugzilla API Key 或密码。

## Resolved Decision Forks
| Decision | Choice | Rationale / Trade-off |
| :--- | :--- | :--- |
| v1 核心垂直切片 | 自动化 Triage 与变更值守（云端唤醒初诊 + 本地看板复核） | 最能同时发挥 MCP Events 与 MCP Apps 的协同优势，单闭环价值最高 |
| 云端写入自治边界 | 分级护栏（Safe-Auto 默认开，Guarded-Write 需放行或人工确认） | 既不沦为纯只读玩具，又把误操作爆炸半径锁在私有评论/标签层 |
| 身份与部署模型 | 混合模式（云端多用户独立绑定 API Key + 本地环境变量直连） | 完美尊重自建 Bugzilla 的安全组/私有单可见性，零串号风险 |
| MCP Events 协议策略 | SEP-3415 为内核（`poll`/`stream`/`webhook`）+ ChatGPT 轻量 Dialect Adapter | 紧跟标准演进，同时不被商业端草案差异反噬核心领域模型 |

## Constraint Split (Handoff Boundary)

### A. Deterministically Verifiable Constraints (Ready for `contract-driven-dev`)
1. 协议与双代兼容：实现 `server/discover`、`resultType`、以及面向可缓存核心方法（`discover`/`list`/`resources/read`）的 `CacheableResult`（`ttlMs` + `cacheScope`），并严格隔离 `2026-07-28` 无状态 `_meta` 与 `2025-11-25` `initialize` 路由；Streamable HTTP 校验 `Origin`（`403`）与缺失/畸形/不匹配的镜像头（`-32020` / HTTP `400`）。
2. 权限与缓存零泄露：多用户模式下所有服务端内部缓存、幂等表、草稿与提案均按 `(principal, instance)` 强制隔离；所有依赖个人 API Key 的可缓存结果标 `cacheScope: "private"`，不存在与无权访问资源对外返回不可区分的 `-32602`；云端通过 URL Elicitation 绑定个人 API Key，MCP Token 绝不透传上游。
3. 写入幂等、状态机与防循环：按 `(principal, instance, operation)` 维护 `pending / applied / failed / indeterminate` 状态机，响应丢失后的 `indeterminate` 严禁自动重发；`Safe-Auto` 私有评论禁止降级为公评；`Guarded-Write` 执行前乐观校验 + 写后差异审计（云端需服务端独立验证一次性审批凭证）；防循环仅依赖可信持久化写溯源 + 服务端因果写入预算。
4. 事件交付与安全契约：支持 `events/list|poll|stream|subscribe|unsubscribe`；游标仅推进至已完整扫描的安全前缀（带滞后窗口），投递与重试前逐条重验当前 Bugzilla 可见性（Fail-Closed）；Webhook 全链路连接（校验/投递/重试/控制帧）强制 HTTPS、连接时公网 IP 固定拨号（保留 Host/SNI）与禁重定向、Standard Webhooks `v1,` HMAC-SHA256、单载荷 `<= 256 KiB` 及持久化 `gap`；配置级独立切换 SEP-3415 与 ChatGPT Dialect。
5. MCP App 安全与边界：拆分 Inline 单卡与 Aux Pane/Global 看板入口；严禁将不可信 Bug 文本拼入 `sendMessage`（user 角色）；草稿按 `(principal, instance, bugId, kind)` + 单调版本保存；主工具序列化结果 `<= 1 MiB`。
6. 版本降级与凭据保护：启动探测 `/rest/version` 与认证身份接口，优先 Header 认证，绝不将 API Key 泄漏进日志、链路追踪、URL 重定向或模型上下文。

### B. Perceptual / Taste / Value Hypotheses (Human & Reality Check Only)
1. 缺陷档案（Dossier）字段配比能否让云端 Agent 在 1~2 轮内产出工程师认可的高质量初诊。
2. 本地 `aux_pane` Triage 看板的“扫队列 → 挂上下文 → 一键审阅提案”体感是否明显快于原生 Bugzilla Web UI。
3. 默认事件轮询节奏与过滤粒度是否平衡了及时性与 Token/打扰成本。
