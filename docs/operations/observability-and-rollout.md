# XD Cell 审计、监控与上线阶段

> 本文从 `docs/pages-v2-wfp-architecture.md` 拆分而来，用于控制单篇文档长度。

## 审计

管理审计由 `pages-api` 写入：

- login
- deploy
- rollback
- delete
- visibility change
- ACL change
- access key create/revoke

访问审计由 `pages-router` 写入或采样写入：

- request id / trace id
- site
- version
- user id / anonymous
- decision: allow / deny / redirect
- visibility
- IP hash 或脱敏 IP
- user agent 摘要
- status code

禁止记录：

- Cookie
- Authorization
- SSO access token
- CLI token
- access key
- internal_worker_jwt
- 请求 body 中的业务敏感内容

## 监控、告警与容量保护

第一版至少需要这些指标：

- route snapshot age、L1/KV hit ratio、D1 fallback rate。
- router IP allowlist deny count、unknown client IP count、allowlist config version。
- strict check latency / error rate。
- dispatch success rate、dispatch 404/5xx、user Worker CPU/subrequest 超限，按 `execution_provider` 维度拆分。
- WFP deploy success/failure、slot deploy success/failure、deploy duration、orphan worker count。
- slot capacity：available / assigned / disabled / available_pending_router 数量、容量水位、扩容失败数、长时间未使用 slot。
- 普通 Worker slot 容量告警只作为 legacy 指标保留；当前新发布不再分配 slot，也不再通过告警引导扩容。不要在 `pages-api` 中保存 GitHub token，也不要让 Slack button 直接触发部署。
- SSO login start/callback failure、CLI login poll/consume failure。
- cross-env guard trip、reserved host/path mismatch。
- audit write backlog、audit dropped/sampled count。

基础容量保护：

- `deploy-api`：限制上传总大小、文件数量、单文件大小、并发部署数和 Cloudflare API retry/backoff。
- `subsite`：按 site/user/IP 做可选限流，避免单站影响平台。
- `kv-gateway`：按 siteUuid、capability scope 和 key prefix 做读写限流。
- `audit`：允许采样访问审计，但管理审计和 deny/security 事件不能静默丢弃。

阶段 0 需要确认目标阈值：站点数、版本数、单站 QPS、部署并发、资产大小、审计保留周期和告警渠道。阈值没确认前，文档只能作为设计草案，不能作为容量承诺。

### Reconciliation 与清理

需要一个后台 reconciliation job 或管理员工具，负责修复最终一致性和清理资源：

| 对象                        | 职责                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| route snapshot              | 对比 D1 `route_generation`、KV pointer 和 immutable snapshot，修复缺失或过期 pointer                                                                                                                                                                                           |
| deployment                  | 修正卡在 `activating` / `uploaded` 的状态，补齐 terminal response                                                                                                                                                                                                              |
| worker slot                 | 对比 `worker_slots`、router binding 和 Cloudflare ordinary Worker，发现 active legacy route、idle Worker、retired Worker 和 Cloudflare 缺失/孤儿状态；当前由 Admin Console 的 `Legacy Normal Workers` 管理页人工删除 idle Worker，`expand-pages-router-slots.yml` 只做只读审计 |
| WFP cleanup task            | `deployment_resource_cleanup_tasks` 是上一版 user Worker 延迟 GC 的真相源；Cron Trigger 小批量处理到期 `pending` / `failed` task，Admin Console 可查看并手动 run；删除前必须确认 active route 不再引用该 `worker_name` 或 `version_id`                                         |
| orphan user worker / assets | failed deployment 诊断和 cleanup task 记录用于定位 orphan；后续可升级为跨 Cloudflare list 的 mark-and-sweep reconciliation                                                                                                                                                     |
| key registry                | 检查 active/draining/retired key 与最大 token TTL 是否匹配                                                                                                                                                                                                                     |

#### 资源治理 P0 盘点

资源治理 P0 的盘点阶段只提供可见性；phase 2 在完整扫描门禁和管理员人工确认下增加回收动作。所有回收仍统一进入既有 cleanup task 管道，不提供旁路删除：

- `Deployment Cleanups > Orphan Scan` 由管理员手动触发，只扫描当前环境 WFP dispatch namespace 的受管脚本，并与 active route、`artifact_availability='active'` 的版本和未完成 cleanup task 对账。响应字段为 `referencedByActiveRoute`、`rollbackEligibleVersion`、`hasPendingCleanupTask` 和 `orphanCandidate`；`orphanReason` 限定为 `no_d1_reference`、`deleted_site`、`stale_previous_version`。这些分类不等同于“可以删除”，也不固化版本保留策略。扫描会先用 namespace `script_count` 校验上游清单完整性；只有 `completeness=complete` 的结果才允许进入回收 backfill，`incomplete` 只能查看并重试。
  上游 dispatch scripts 清单端点目前没有正式 API reference / SDK 分页契约：客户端仅在 `result_info` 完全缺失时把本页视为 undocumented single-page 候选；只要 `result_info` 存在，就必须是包含原生正整数 `page` / `total_pages` 的合法对象，否则 fail-closed。随后读取 namespace 详情中的 `script_count` 做完整性校验；每条清单记录也必须解析出非空 Worker name。首次数量不一致会重试一次，仍不一致时返回 `completeness: 'incomplete'`，同时保留 `scannedCount` 和 `namespaceScriptCount`，Console 必须显示警告。未来删除阶段只能基于 `completeness: 'complete'` 的扫描结果做删除决策；不完整扫描不得触发回收。
- `Legacy v1 Sites` 通过 `pages-api` 直接读取当前环境的 v1 SITES KV 和 account-level Workers，再与未删除的 v2 同名站点对账。页面只展示站点名称、URL、preset、网络限制、更新时间、对应 v1 Worker 和迁移候选标记；KV metadata 中的站点凭证和其它内部字段不会进入响应或页面。
- Dashboard 只查询 D1 中 cleanup task 的 pending / failed 数量与最老 pending 积压时长，不扫描 WFP namespace 或 v1 KV。Orphan candidate 和 v1 站点总数保持按需盘点，不得把未知值显示为零。

Orphan backfill 与 v1 退役均为平台管理员显式操作。v2 回收统一进入现有 `deployment_resource_cleanup_tasks` 管道，并继续执行 active route 复核、drain window 和失败重试；不要另建旁路删除流程。v1 退役仅处理人工确认不再使用的 KV 站点，unknown 与 platform_reserved Worker 永远只展示、不可选。站点删除成功后的 v2 Worker 也只入 cleanup task，不在删除请求内直接删除脚本。

v1 盘点依赖 pages-api Worker secret `PAGES_V1_SITES_KV_NAMESPACE_ID`，并复用 Cloudflare account 与 API credential secret。该值由 v2 deploy workflow 直接引用 v1 既有 GitHub Environment secret `SITES_KV_NAMESPACE_ID` 注入，不需要新增 GitHub secret。缺少配置时，接口按 `V1_SITES_UNSUPPORTED` 返回 503，Console 应保留其它管理能力可用。production 与 staging 必须分别配置对应 namespace，且盘点只接受本环境的 v1 Worker 前缀并显式排除 v2 前缀。

key rotation 生命周期：

```text
publish -> activate -> drain -> retire
```

重叠窗口至少覆盖最大 token TTL + route/JWKS KV TTL。retire 前必须确认没有仍需验证该 `kid` 的 session、internal JWT 或 capability。WFP Worker GC 的 drain window 默认 5 分钟，可通过环境变量收紧或放宽；Cron Trigger 默认每 15 分钟小批量处理到期 cleanup task。GC 失败只更新 cleanup task，不影响已成功发布的 active route。

## 平稳上线阶段

### 阶段 0：设计与资源验证

- 确认 Workers for Platforms 可用性、配额、billing 和 staging 资源。
- 确认存量普通 Worker active route、router wrangler template 可读性、只读审计 workflow 和管理员删除流程。
- 新增并验证 v2 `workers` / `*.workers` 与存量 v2 `pages` / `*.pages` DNS、证书 DCV 和 Cloudflare route；确认 v2 workers wildcard 不影响 v1 exact route。
- 验证 Cloudflare route：`*-staging.workers.xd.team/*` 和 `*-staging.pages.xd.team/*` 是否稳定进入 `pages-router-staging`，且 API/auth exact route 优先级正确。
- 如果 route spike 不满足要求，验证 `pages-edge-router-thin` fallback，确认它不持有业务 secret。
- 确认 SSO redirect URI。
- 确认 static/spa assets 在当前 execution mode 下的实现路径。
- 确认 SSO profile 是否包含稳定 user id、邮箱和 employee status。
- 确认公司内网、VPN、办公出口和必要代理出口的 CIDR 清单，并确定维护/回滚流程。
- SSO 接入材料只作为本地临时参考，不进入提交；上线前删除本地参考，或替换为不含 token-like 示例、真实 host query、危险日志和硬编码口令的脱敏摘要。
- 增加 workflow 静态校验：production 不允许 push/PR 自动部署，token 名称、route pattern、resource id、binding 环境必须匹配。

### 阶段 1：新控制面与 CLI 登录

- 新增 `pages-auth`。
- 新增 `pages-api` 的登录态校验和 access key。
- CLI 支持 `xd-cell login`、`login_id + login_secret` 轮询、`xd-cell login --token <token>` 保存凭证，以及 API 命令的单次 `--token <token>`。
- AI skill 改为只调用 XD Cell CLI。
- 现有 `apps/server` 继续服务旧版 `workers.xd.team`，新架构不改旧版 API、skill、README 或发布行为。

### 阶段 2：发布 MVP（可上线受保护站点的最小闭环）

- 新增 `pages-router`。
- 新增 `pages-router-staging`，production/staging router 物理隔离。
- 按 `PAGES_EXECUTION_MODE` 启用执行面：
  - 默认：`wfp`，使用 dispatch namespace。
  - 兼容：`normal-worker-slot`，仅用于历史 route 排空。
- 用户仍只执行 `xd-cell deploy ./dist foo`，不暴露 execution provider 参数。
- 支持 `internal` 和 `org` visibility。
- 支持 router IP allowlist 强限制；未命中公司网络直接 403。
- 支持站点级 `site_session`、员工 active 状态校验、header/cookie 清洗和 `internal_worker_jwt`。
- 支持发布/回滚状态机、route snapshot generation 和基础故障矩阵。
- 支持最小化披露、平台能力 gateway 和 egress 审计；强制 egress 阻断进入阶段 4。
- 支持访问审计。

### 阶段 3：子站 SSO 与 ACL

- 支持 `acl` 和 `owner` visibility。
- 支持 allow-only OR ACL：第一版公开 API 开放 `email` 和 `department` path，`owner` 使用内部 user id 判断。
- `group`、`deny`、条件表达式、collaborator 管理和策略语言进入后续阶段，等组织目录和权限语义稳定后再开放。
- 完成更细的 user/session revocation、risk policy 和管理 UI 入口。

### 阶段 4：执行面治理

- 默认 `PAGES_EXECUTION_MODE` 已切到 `wfp`；`pages-api` 新发布进入 WFP，router 静态持有 `PAGES_DISPATCH`，只继续保留历史 slot bindings 直到旧 route 排空。
- 根据试点情况决定是否迁移已有 slot 站点；不强制迁移，但新发布和 rollback 都不再写回 slot。
- 禁用普通 Worker 新站点分配，只保留 active legacy route 访问和管理员删除 idle Worker。
- Outbound Worker / 强制 egress policy。
- 更细的资源限制。
- 更完善的审计查询。
- 管理 UI。

## 风险和约束

| 风险                        | 说明                                                                             | 缓解                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SSO clientSecret 泄露       | OAuth 换 token 需要 secret                                                       | 只放 Worker secret，不进 CLI/浏览器/日志                                                                                                      |
| session 不可吊销            | 纯本地 JWT 验证性能好但吊销慢                                                    | 短 TTL + sid + 高风险操作查状态                                                                                                               |
| staging/prod 串环境         | route 或 binding 选错影响 P0                                                     | 双 router 物理隔离，thin router 不持有 secret                                                                                                 |
| 子站公网暴露                | 未来 public exposure 如果混入第一版 visibility 会造成误解                        | 第一版只开放 `internal`，router 强制 IP allowlist；公网能力后续以 `exposure + access` 单独设计                                                |
| 用户 Worker 伪造身份        | 浏览器可伪造普通 header                                                          | router 清洗入站 header，并注入签名内部 JWT                                                                                                    |
| User Worker 覆盖平台 cookie | 不可信代码可返回 Set-Cookie                                                      | router 清洗平台保留 cookie/header                                                                                                             |
| User Worker 设置父域 cookie | 可污染 sibling 子站或平台 host                                                   | 只允许 host-only cookie，拒绝父域 Domain                                                                                                      |
| internal JWT 被当能力凭证   | User Worker 可复制短期 JWT                                                       | 平台能力使用独立 capability，不信 internal JWT                                                                                                |
| 旧版/新架构心智混淆         | 用户可能把 v2 新建 `workers.xd.team` 子站和 v1 `apps/server` 旧链路混为一谈      | 文档、CLI help、错误提示和 skill 明确 v2 控制面是 `api/auth.pages.xd.team`，新建子站默认 `workers.xd.team`，但不调用 v1 `api.workers.xd.team` |
| assets 承载方式不确定       | WFP、slot 与 Workers Assets 组合需验证                                           | 阶段 0 做 spike；DR 0003 的 R2 artifact store 作为低优先级长期候选，不阻塞当前 MVP                                                            |
| WFP dispatch 部署失败       | 新版本无法进入目标执行面                                                         | fail closed，保留旧 active route；修复 WFP 后重新发布，不回退到 normal slot                                                                   |
| slot binding 数量上限       | 历史普通 Worker slot 需要 router 静态 binding                                    | WFP 模式停止扩张，只渲染 active legacy route 的显式 binding                                                                                   |
| slot 误清理 active 版本     | active slot 被释放会导致当前站点不可访问                                         | 清理前后都用 D1 条件确认没有 active route 引用该 slot 或 version；失败时保持 `cleanup_pending`，不回到 `available`                            |
| 新 wildcard 配置风险        | `*.workers.xd.team` 是 v2 新建站点默认入口，`*.pages.xd.team` 仍承载存量 v2 站点 | staging 验证、DNS/证书/route 静态校验、快速回滚                                                                                               |
| production 自动部署风险     | 当前项目要求生产手动部署                                                         | CI 继续保持 production manual                                                                                                                 |

## 需要进一步确认的问题

1. 心动 SSO 是否能提供稳定用户唯一 ID、邮箱和员工状态；离职或禁用状态是否会实时体现在 profile。
2. 是否有组织/部门/群组接口可用于 `acl` 的 group 规则。
3. Workers for Platforms 在当前账号何时开通，以及 dispatch namespace、user worker、outbound worker 的配额和计费。
4. 普通 Worker service binding 在当前账号和 Worker 中的数量上限、部署时长、日志和计费边界。
5. WFP user Worker 或普通 Worker slot 是否可直接承载 static/spa assets 模型；如果不能，优先选择 R2 还是独立 asset store。
6. 访问审计的保留周期、查询方式和敏感字段脱敏标准。
7. CLI custom env 的开放范围：第一版作为隐藏开发保留项，只允许 loopback，不进入用户侧 help/list；无论哪种方式都不用于旧版兼容。
8. Cloudflare route 是否支持 `*-staging.workers.xd.team/*` 稳定优先于 `*.workers.xd.team/*`，以及 `*-staging.pages.xd.team/*` 稳定优先于 `*.pages.xd.team/*`；如果不支持，是否接受 `pages-edge-router-thin`。
9. SSO token endpoint 是否支持 POST；如果只能 GET，日志脱敏链路是否可验证。
10. SSO profile 中 employee status 原始值到 `active / disabled / left / unknown` 的映射表和 freshness SLA。
11. MVP 是否必须强制 egress 阻断；如果必须，需要把 Outbound Worker 提前到阶段 2。
12. 公司内网/VPN/办公出口 CIDR 的权威来源、更新频率和紧急回滚流程。

## 第一版验收标准

- 用户必须登录后才能发布 XD Cell 站点。
- 用户 CLI 不暴露 execution provider；`xd-cell deploy` 由平台 `PAGES_EXECUTION_MODE` 决定部署到 WFP 或 ordinary Worker slot。
- `wfp` 模式下新发布进入 dispatch namespace，且用户命令不需要感知 execution provider。
- production/staging 由不同 router Worker 和不同资源承载；如果使用 thin router，它不能持有业务 secret。
- pages-router 第一版必须强制 IP allowlist；未命中公司网络的请求直接 403，且不 dispatch 到 User Worker。
- `xd-cell deploy --visibility org` 发布的站点，未登录访问会跳转 SSO。
- `org` 站点只允许 active employee 访问；disabled/left/unknown 默认拒绝或 strict 校验后拒绝。
- 登录后访问受保护子站不回 `pages-api`。
- User Worker 收到签名内部 JWT，不能依赖浏览器 cookie。
- 浏览器伪造的 `CF-Platform-*` / `X-Pages-*` header 会被删除。
- User Worker 不能设置平台保留 cookie 或父域 cookie。
- `internal_worker_jwt` 不被平台 API / gateway 当作通用 capability。
- 发布和回滚遵循状态机，失败不会覆盖旧 active version。
- CLI login 需要用户在浏览器确认终端短码、environment、auth host 和 scope。
- API host 不直接依赖 auth host 的 `auth_session`；浏览器态 API 使用独立 host-only `api_session`。
- `internal` 站点在公司网络内无需登录可访问，但仍有站点 metadata 和审计；第一版不支持互联网公开子站。
- CLI 支持浏览器登录和 access key 两种模式。
- CLI 只支持 XD Cell v2 控制面，不能静默调用 v1 `api.workers.xd.team`，也不能绕过 hostname claim 抢占 v1 exact route。
- 旧版 `apps/server` 站点、API、skill 和发布链路不受新架构改动影响；新建 v2 子站默认 `workers.xd.team` 后缀由 `pages-router` wildcard 承载。
- 文档、测试和日志不包含真实 secret、真实 token 或真实 Cloudflare 资源 id。
