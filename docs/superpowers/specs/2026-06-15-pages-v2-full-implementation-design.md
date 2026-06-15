# pages-manager v2 完整实现设计

## 背景

`pages-manager` v1 继续服务 `*.workers.xd.team`，现有 `apps/server`、旧 API、旧 skill 和旧发布链路不因 v2 改动而变化。

v2 是一套全新 `*.pages.xd.team` 平台，目标是基于 Cloudflare Workers for Platforms 建立带发布鉴权、公司 SSO、子站 SSO、多租户执行隔离、统一审计和 v2-only CLI 的完整站点发布系统。

本设计基于 `docs/pages-v2-wfp-architecture.md`，目的是把架构草案拆成可连续实施、可验证、可回滚的路线。分阶段只是施工顺序，不代表功能降级。

## 目标

- v2 发布必须使用强认证，支持人类用户、CI 和 agent。
- 子站默认通过 `pages-router` 统一门禁：IP allowlist、visibility、SSO、ACL、header/cookie 清洗和审计。
- 用户 Worker 运行在 Workers for Platforms dispatch namespace，默认不可信。
- production / staging 使用独立 Worker、D1、KV、DO、dispatch namespace、signing key 和 SSO redirect URI。
- CLI 只适配 v2 `pages.xd.team`，拒绝 `workers.xd.team`。
- 支持 static、SPA 和 custom Worker 发布，用户不需要理解 WFP、dispatch namespace 或资产存储实现。
- 保持 v1 完全可用，不迁移、不 claim、不接管 `*.workers.xd.team` route。
- 每个里程碑都有 focused tests、环境串用测试和安全边界测试。

## 非目标

- 不改 v1 `apps/server` 的公开行为。
- 不提交 `docs/xd-sso.md`；它只作为本地临时参考，上线前删除或替换为全量脱敏摘要。
- 不在第一版开放真正互联网公开子站。第一版 `public` 只表示公司网络内匿名可访问。
- 不让 User Worker 持有平台 secret、Cloudflare API token、SSO token、auth/session cookie 或全局 metadata/session/audit store。
- 不把 `internal_worker_jwt` 当作平台 API 或 gateway capability。

## 推荐路线

采用 MVP 垂直闭环路线：先建立安全数据面，再补身份、控制面、CLI、WFP 发布和平台能力。最终功能完整，只是按风险和依赖顺序落地。

### M1. Router 安全底座

新建 `apps/pages-router`。

职责：

- 解析 `*.pages.xd.team` 和 `*-staging.pages.xd.team` hostname。
- 拒绝平台保留 host、保留 slug、非法 host 和跨环境 host。
- 第一时间执行公司 IP allowlist；未命中直接 403，不读取 route，不 dispatch。
- 处理 `/.xd-pages/*` 平台保留路径，默认不转发到 User Worker。
- 读取 route snapshot 接口，第一版可用内存/mock 数据驱动测试。
- dispatch 前删除伪造的 `CF-Platform-*`、`X-Pages-*`、`X-XD-Pages-*` header。
- dispatch 前重写 `Cookie` header，移除 `__Host-pages_*`、`__Secure-pages_*`，避免把 `site_session` 暴露给 User Worker。
- 注入 `CF-Platform-Auth` 和最小可信上下文。
- dispatch 后删除平台保留 header 和平台保留 `Set-Cookie`。
- 产出访问审计事件结构。

验收：

- IP allowlist 缺失、格式错误或未命中时 fail closed。
- `api.pages.xd.team`、`auth.pages.xd.team`、staging 系统域名不能被当作子站。
- staging/prod hostname 与环境不一致时 fail closed。
- User Worker 收不到平台 session cookie。
- 单测覆盖 host classification、reserved path、IP gate、cookie/header 清洗和 mock dispatch。

### M2. Auth / Session 底座

新建 `apps/pages-auth`。

职责：

- 实现 OAuth state DO，一次性消费，绑定 return_to 和 site host。
- 实现 CLI login DO，使用 `login_id + login_secret + device code`；browser authorize URL 只携带 `login_id`，device code 必须由用户在 SSO 后确认页手动输入。
- 支持 `auth_session`、`site_session` 的签发、刷新和吊销结构。
- 通过 service binding 与 router/API 协作，不暴露内部 token 到浏览器 URL。
- 本地 SSO 配置只读取 ignored env 或 shell 环境变量。

验收：

- OAuth state 过期或重复消费失败。
- CLI login 未手动确认 device code 前不能完成，不能把 device code 放入 authorize URL 自动确认。
- `auth_session` 只在 `auth.pages.xd.team` 生效。
- `site_session` 只在子站 host 生效。
- token 校验必须包含 `iss`、`aud`、`kid`、环境和用途绑定。
- 签名 secret 只放在签发对应 token 的组件中；`pages-api` 只能通过 JWKS / public key 或 `pages-auth` service binding 校验用户态 token。
- SSO secret、access token、OAuth code 不进入日志、CLI config、`.pages.json` 或错误响应。

### M3. API / D1 控制面

新建 `apps/pages-api`。

职责：

- 建立 D1 schema：users、sites、site_routes、site_versions、deployments、site_members、site_acl_entries、access_keys、auth_sessions_index、audit_events。
- 实现 sites、deployments、versions、rollback、access keys 的最小 API。
- access key 使用 CSPRNG 明文，只显示一次；服务端保存 HMAC/hash 和 pepper id。
- deploy/rollback 使用 idempotency key 和 canonical request hash。
- 生成 immutable route snapshot 和 route pointer。
- 输出 v2-only OpenAPI skeleton。

验收：

- v2 API 不接受 `X-Pages-Token`。
- access key 创建、查询、吊销不泄露明文。
- 同 idempotency key + 同 request hash 返回同一 deployment；不同 hash 返回 409。
- D1 是权威，KV snapshot 只是快路径缓存。
- public docs 不返回 v1 API 地址，不返回真实 secret 或资源 id。

### M4. CLI v2-only

实现 v2 `pages` CLI 行为。当前落地包为 `apps/pages-cli`，bin 为 `pages`。

职责：

- 支持 `pages login` 浏览器登录和轮询领取 CLI token。
- 支持 `pages login --access-key <key>` 显式保存 access key，以及 `PAGES_ACCESS_KEY` 用于 CI / agent。
- 支持 `pages deploy`、`pages status`、`pages rollback`、`pages open`、`pages env`。
- 支持 `.pages.json` flat v1 项目绑定；跨 environment 时不能复用其它环境的 `siteId`。
- 使用 OS secret store；fallback 文件必须校验 POSIX mode 或 Windows ACL。
- 内置 production/staging 只指向 `pages.xd.team`。

验收：

- CLI 指向 `workers.xd.team` 时直接拒绝。
- production/staging env 不可被用户本地 config override。
- custom env 第一版只能指向 localhost / loopback；未来如需公司 v2 测试域，必须由受信 allowlist 扩展，不能把 token/access key 发往任意第三方 host。
- production/staging token、profile 和 access key 隔离。
- `.pages.json` 不存 token、cookie、Cloudflare id、SSO secret 或 capability。
- `pages deploy --env staging` 不能复用 production `.pages.json` 的 `siteId`。
- Windows fallback secret 文件 ACL 不安全时拒绝读取。
- v2 AI skill 只调用 CLI，不手写 API 请求。

### M5. WFP 发布闭环

新增 `packages/wfp-client`，由 `apps/pages-api` 唯一调用 Cloudflare WFP API。

职责：

- 读取 `CF_ACCOUNT_ID`、`CF_API_TOKEN`、`WFP_DISPATCH_NAMESPACE`、可选 `WFP_COMPATIBILITY_DATE` 和 `CF_API_BASE_URL`；production / staging 的 `CF_API_BASE_URL` 只能是 Cloudflare 官方 host。
- 强制 production 使用 `pages-production` dispatch namespace，staging 使用 `pages-staging`。
- 上传 custom Worker artifact bundle 到 dispatch namespace。
- 第一版由 CLI 为 static / SPA 生成 WFP-compatible user Worker，内嵌 base64 asset map；后续可迁移到 R2 / asset store 而不改变 CLI 命令形态。
- 创建 immutable version。
- 按状态机切 active route：pending -> uploading -> uploaded -> verified -> activating -> succeeded。
- 支持 rollback，复用 active route 切换流程。
- 通过 failed deployment、非 active version 和 WFP 命名规则推导 orphan user Worker / assets，交给 reconciliation 清理；后续再补显式 orphan 标记。

验收：

- verified 前不切 active route。
- 失败不会覆盖旧 active version。
- 回滚不修改历史 version。
- staging/prod dispatch namespace 不可串。
- Cloudflare API token 只存在 `pages-api` runtime。
- CLI deploy 请求必须包含 `artifactBundle`，并纳入 idempotency request hash；bundle 不包含本地绝对路径、`.pages.json`、token、Cloudflare 资源 id 或 secret。
- 第一版 custom Worker 只直传 `.js` / `.mjs`；`.ts` 入口在接入 bundler 前 fail closed。
- 第一版 static / SPA generated-worker 路径有明确大小上限；超限后转向 R2 / asset store 路径。

### M6. 子站 SSO + Visibility + ACL

职责：

- 支持 `public`、`org`、`acl`、`owner`、`disabled`。
- 第一版所有 visibility 都受 IP allowlist 约束。
- `org` 只允许 active employee。
- `acl` 使用 allow-only + OR 叠加，支持指定多人、指定人 + 部门。
- 当前 API 开放 `user`、`email`、`department`，其中 `department` 依赖组织系统提供稳定 ID、成员快照版本和 TTL；`group`、`deny`、条件表达式和策略语言后置。
- visibility、ACL、owner、用户状态变化必须 bump `policyVersion` 或 `sessionVersion`。
- `PATCH /.xd-pages/api/sites/{id}` 只允许 owner 修改 visibility，更新 D1 权威路由并刷新 active route snapshot。
- `GET/PUT /.xd-pages/api/sites/{id}/acl` 读取或全量替换 ACL；PUT 只允许 owner，access key 不能管理策略。
- route snapshot key 必须包含 `routeGeneration` 和 `policyVersion`，避免 policy-only 变更覆盖发布 generation 对应的旧 snapshot。
- route pointer 写入前必须做单调版本保护，禁止旧 `routeGeneration` 或旧 `policyVersion` 覆盖新 pointer；后续用 `SitePolicyDO` / CAS 收敛并发写窗口。

验收：

- disabled、left、unknown 默认拒绝或 strict 后拒绝。
- 受保护站点登录后访问不回 `pages-api`。
- ACL 命中任意 allow entry 即可访问，未命中拒绝。
- ACL / visibility 变更能让旧 `site_session` 在可接受窗口内失效。
- `site_session` 需要 `userCheckedAt` freshness 窗口，避免员工离职/禁用状态滞留到完整 cookie TTL。
- OpenAPI 必须暴露 visibility / ACL 契约，并明确第一版只支持 allow-only。

### M7. 平台能力与运行边界

升级 `apps/kv-gateway` 为 v2 capability 模型。

职责：

- capability 绑定 `siteUuid`、scope、method/path、TTL 和环境。
- `site.kv` 使用 `siteUuid` 隔离。
- 可选 `user.kv` 只能从 router 签名身份推导 `userId`，不能由浏览器或 User Worker 传入。
- 提供 SDK helper 验证 `internal_worker_jwt`。
- 第一版先做最小化披露和 egress 审计；强制 Outbound Worker 治理进入后续执行面阶段。

验收：

- internal JWT 不能当 gateway capability。
- User Worker 不能自行声明 userId 访问他人数据。
- 平台 secret 不注入 User Worker。
- 访问平台保留 host 的尝试进入审计或安全告警。

### M8. CI / Config / Docs / Release Gate

职责：

- 新增 v2 wrangler templates；三套系统 Worker 使用 production/staging 显式模板，渲染器只做占位符替换和校验，不在 shell 里生成环境拓扑。
- 新增 staging/production GitHub Actions，保持 production 手动部署。
- 增加配置静态校验：域名、route、binding、secret、dispatch namespace、D1/KV/DO 必须与环境匹配。
- 生成 v2 OpenAPI、skill、README/API 文档。
- 提供 smoke tests 和第一版验收清单。

验收：

- production 不会被 push/PR 自动部署。
- staging/prod Worker、KV、D1、DO、route、signing key、dispatch namespace 不串用。
- `docs/xd-sso.md` 不进入提交。
- v2 docs / OpenAPI / skill 不出现旧 v1 API 地址，除非是在说明 v1 不受影响。

## 组件边界

`pages-router` 是数据面，不做发布，不持有 Cloudflare API token。

`pages-auth` 是身份面，持有 SSO secret，不部署 user Worker。

`pages-api` 是控制面，唯一持有 WFP 发布能力，不进入子站访问快路径。

`pages CLI` 是用户入口，只调用 v2 API/Auth，不直连 Cloudflare，不兼容 v1。

`kv-gateway` 是能力网关，只接受平台 capability，不接受浏览器自声明身份。

默认身份披露遵循最小化原则。router 注入给 User Worker 的身份只包含 `sub` / scoped user id、site、route、version、roles 和 trace id。邮箱、姓名、部门、组等 profile 字段必须由站点显式申请 profile disclosure scope，并经过平台策略允许后才注入 header/JWT。

## 存储与一致性

D1 是权威业务库。KV 只做 route/policy/JWKS snapshot。Durable Objects 只做强一致协调。router L1 cache 只做短 TTL 加速。

一致性按风险分级：

```text
fast       public/org 普通访问，允许短传播窗口
sensitive  acl/owner，短 TTL，版本不匹配强制刷新
strict     disabled/delete/revoke/key 操作，查 D1/DO
```

缓存失效依赖版本号：

```text
routeGeneration
policyVersion
sessionVersion
kid
```

## 测试策略

每个里程碑至少包含：

- 单元测试：纯函数、schema、状态机、鉴权判断。
- Worker fetch 测试：路由、cookie/header、错误响应。
- 环境隔离测试：production/staging route、binding、issuer、audience、key registry。
- 安全边界测试：token 不泄露、User Worker 不能收到平台 cookie、v2 不接受 v1 token。
- 配置测试：wrangler template、GitHub Actions 和 generated docs 不串环境。

## 发布与回滚

每个里程碑应独立可回滚。建议每个里程碑一个 PR，或者至少一个可回滚 commit。生产部署继续手动触发。试点阶段先在 staging 验证 `pages.xd.team` DNS、证书、route 优先级、SSO redirect 和 WFP dispatch namespace。

## 风险与处理

- Cloudflare wildcard route 对 `*-staging.pages.xd.team` 的支持需要阶段 0 spike；不满足时使用无业务 secret 的 thin router。
- WFP static/spa assets 能力需要验证；不满足时使用 R2 或专用 asset store，用户命令保持不变。
- SSO profile 如果缺少稳定 user id 或员工状态，需要把 `org` 的吊销语义降级为 profile freshness SLA，不能宣称实时。
- Outbound Worker 未接入前，不能宣称可阻止恶意 User Worker 外传其已可见数据。
- `docs/xd-sso.md` 是本地参考，不能提交；如需提交 SSO 文档，必须写脱敏摘要。

## 验收清单

- v1 `*.workers.xd.team` 不受影响。
- v2 CLI 只支持 `pages.xd.team`。
- 用户必须登录或使用 access key 才能发布。
- router 第一版强制 IP allowlist。
- protected 子站登录后不回 `pages-api`。
- dispatch 前不向 User Worker 传平台 cookie。
- User Worker 默认不能收到 raw email 等直接 PII。
- User Worker 响应不能覆盖平台 cookie/header。
- deploy / rollback 遵循状态机。
- staging/prod 资源物理隔离。
- 文档、测试和日志不包含真实 secret、真实 token 或真实 Cloudflare 资源 id。
