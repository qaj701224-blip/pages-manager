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
- 普通 Worker slot 容量耗尽时，`pages-api` 通过 `SLACK_PAGES_ALERT_WEBHOOK_URL` 发送 Slack 运维告警；第一版消息只 @ `SLACK_PAGES_ALERT_MENTION_USER_ID` 一次，并展示“环境 / 容量 / 剩余 / 扩容”。其中“容量”是当前已用 Worker / 当前总 Worker，“剩余”是当前可被发布使用的 available Worker 数量。按钮使用 GitHub Actions URL button，打开 `https://github.com/xindong/pages-manager/actions` 让维护者手动运行对应环境的 XD Cell deploy workflow。不要在 `pages-api` 中保存 GitHub token，也不要让 Slack button 直接触发部署。
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

| 对象                        | 职责                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| route snapshot              | 对比 D1 `route_generation`、KV pointer 和 immutable snapshot，修复缺失或过期 pointer                                                      |
| deployment                  | 修正卡在 `activating` / `uploaded` 的状态，补齐 terminal response                                                                         |
| worker slot                 | 对比 `worker_slots`、router binding 和 Cloudflare ordinary Worker，发现 `available_pending_router` 卡住、assigned 但无 active route、长期未使用等状态；当前由 `expand-pages-router-slots.yml` 的 `operation=cleanup` 手动触发清理 |
| orphan user worker / assets | reconciliation 根据 failed deployment、非 active version、WFP 命名规则、slot 状态和审计引用推导 orphan；后续可升级为显式标记表和 mark-and-sweep 清理 |
| key registry                | 检查 active/draining/retired key 与最大 token TTL 是否匹配                                                                                |

key rotation 生命周期：

```text
publish -> activate -> drain -> retire
```

重叠窗口至少覆盖最大 token TTL + route/JWKS KV TTL。retire 前必须确认没有仍需验证该 `kid` 的 session、internal JWT、capability 或 rollback window。

## 平稳上线阶段

### 阶段 0：设计与资源验证

- 确认 Workers for Platforms 可用性、配额、billing 和 staging 资源；如果暂未开通，确认 `normal-worker-slot` 兼容上线范围。
- 确认普通 Worker slot binding 数量上限、router wrangler template 可读性、扩容 workflow、容量告警和回滚流程。
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
  - WFP 未开通：`normal-worker-slot`，先创建少量 staging / production slot。
  - WFP 已开通：`wfp`，使用 dispatch namespace。
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

- WFP 开通后，通过 PR 将 `pages-api` 和 `pages-router` 的默认 `PAGES_EXECUTION_MODE` 从 `normal-worker-slot` 切到 `wfp`。
- 根据试点情况决定是否迁移已有 slot 站点；不强制迁移也可以作为短期回滚手段保留。
- 禁用普通 Worker 新站点分配，只允许已有 slot 站点维护或管理员迁移。
- Outbound Worker / 强制 egress policy。
- 更细的资源限制。
- 更完善的审计查询。
- 管理 UI。

## 风险和约束

| 风险                        | 说明                             | 缓解                                                                 |
| --------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| SSO clientSecret 泄露       | OAuth 换 token 需要 secret       | 只放 Worker secret，不进 CLI/浏览器/日志                             |
| session 不可吊销            | 纯本地 JWT 验证性能好但吊销慢    | 短 TTL + sid + 高风险操作查状态                                      |
| staging/prod 串环境         | route 或 binding 选错影响 P0     | 双 router 物理隔离，thin router 不持有 secret                        |
| 子站公网暴露                | 未来 public exposure 如果混入第一版 visibility 会造成误解 | 第一版只开放 `internal`，router 强制 IP allowlist；公网能力后续以 `exposure + access` 单独设计 |
| 用户 Worker 伪造身份        | 浏览器可伪造普通 header          | router 清洗入站 header，并注入签名内部 JWT                           |
| User Worker 覆盖平台 cookie | 不可信代码可返回 Set-Cookie      | router 清洗平台保留 cookie/header                                    |
| User Worker 设置父域 cookie | 可污染 sibling 子站或平台 host   | 只允许 host-only cookie，拒绝父域 Domain                             |
| internal JWT 被当能力凭证   | User Worker 可复制短期 JWT       | 平台能力使用独立 capability，不信 internal JWT                       |
| 旧版/新架构心智混淆        | 用户可能把 v2 新建 `workers.xd.team` 子站和 v1 `apps/server` 旧链路混为一谈 | 文档、CLI help、错误提示和 skill 明确 v2 控制面是 `api/auth.pages.xd.team`，新建子站默认 `workers.xd.team`，但不调用 v1 `api.workers.xd.team` |
| assets 承载方式不确定       | WFP、slot 与 Workers Assets 组合需验证 | 阶段 0 做 spike；DR 0003 的 R2 artifact store 作为低优先级长期候选，不阻塞当前 MVP |
| WFP 暂未开通                | 首发无法使用目标执行面           | 使用 `normal-worker-slot` 兼容层，用户 API 不变，后续切换默认 mode   |
| slot binding 数量上限       | 普通 Worker slot 需要 router 静态 binding | 预留小规模池、容量告警、人工扩容 workflow，WFP 开通后停止扩张 |
| slot 误清理 active 版本      | active slot 被释放会导致当前站点不可访问 | 清理前后都用 D1 条件确认没有 active route 引用该 slot 或 version；失败时保持 `cleanup_pending`，不回到 `available` |
| 新 wildcard 配置风险        | `*.workers.xd.team` 是 v2 新建站点默认入口，`*.pages.xd.team` 仍承载存量 v2 站点 | staging 验证、DNS/证书/route 静态校验、快速回滚                      |
| production 自动部署风险     | 当前项目要求生产手动部署         | CI 继续保持 production manual                                        |

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
- WFP 未开通时，`normal-worker-slot` 能发布试点站点；WFP 开通后切换默认 mode 不改变用户命令。
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
