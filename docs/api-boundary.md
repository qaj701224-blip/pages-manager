# XD Cell API Boundary

本文定义 XD Cell v2 的 CLI-managed API boundary。它不是 endpoint reference，也不是 CLI 使用指南。

普通用户、AI agent 和 CI 的入口是 `xd-cell` CLI 与 `xd-cell` skill。它们不手写部署 HTTP 请求，不拼接认证 header，不直接构造上传协议。CLI 负责认证、目录识别、打包上传、重试和结果解释。

## 边界结论

- `apps/pages-api` 不公开 `/openapi.json` 或 `/.xd-pages/api/openapi.json`。
- `apps/pages-api/src/openapi.js` 是开发期 API 合约源码，只服务实现、测试和受控内部集成。
- 受控集成可使用经过认证的站点级 vars/secrets mutation API；普通用户和 agent 仍通过 `xd-cell` 操作，OpenAPI 不因此成为公开入口。
- 站点 `visibility` 继续是 CLI/API 兼容字段，其中 `internal` 映射为匿名 access mode；网络 `exposure` 是独立的 Platform Admin 能力，普通用户 visibility、ACL、deploy 和 rollback 请求不得修改它。
- API 文档不复刻不完整 endpoint 清单；需要改 API 行为时，以 handler、`apps/pages-api/src/openapi.js` 和 focused `node:test` 一起更新为准。
- 用户可见发布、状态、访问控制和回滚流程以 CLI help 与 `apps/pages-skill/skill/SKILL.md` 为准。
- v1 `apps/server` 已进入墓碑模式；除精确的 `GET/HEAD /health` 外，`/deploy`、`/list`、`/site/:name`、`/openapi.json`、Markdown 路由和未知路径都返回 `410 LEGACY_API_RETIRED`，不再提供旧 OpenAPI 或管理能力。
- Cindy 客户端使用 `xd-sites` 插件；若找不到插件，先更新 Cindy 客户端。非 Cindy 客户端使用 `https://skills.xindong.com/skills/xd-cell` 的 skill。

## 真相源

| 领域               | 真相源                                                                                                                   | 说明                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 用户和 agent 操作  | `xd-cell` CLI help、`apps/pages-skill/skill/SKILL.md`                                                                    | 发布、状态、访问控制、回滚和错误处理          |
| API 开发合约       | `apps/pages-api/src/openapi.js`、对应 handler、`node:test`                                                               | 开发、测试和受控内部集成，不作为 public route |
| 项目架构入口       | `README.md`、`docs/README.md`                                                                                            | monorepo 架构、文档索引和真相源矩阵           |
| v1 legacy API 退休 | `apps/server/README.md`、`apps/server/src/retirement.js`、`docs/operations/legacy-api-and-site-publishing-retirement.md` | 410 协议、资源保留和人工上线顺序              |

## 开发规则

- 认证、上传协议、幂等 key、multipart payload 和轮询细节都是 CLI 内部协议，不作为用户或 AI 的手写 API。
- 改 API 行为时，同步 handler、`apps/pages-api/src/openapi.js`、focused `node:test` 和受影响的 CLI/skill 文档。
- 新增或修改用户可见能力时，先确认 CLI help、`apps/pages-skill/skill/SKILL.md`、`README.md`、`docs/README.md` 和本文没有互相漂移。
- 不在公开文档中暴露发布 token、CLI access key、历史 CLI JWT（仅作拒绝行为说明）、cookie、SSO code、session、provider、WFP、slot、dispatch namespace、Cloudflare resource id 或 runtime capability。
- 不为了方便调试把 v2 `/openapi.json` 重新作为 public route 暴露。

## Cindy Connections 断言鉴权

Cindy(原 XDMaker)的 v2 客户端形态是 Cindy 插件 `xd-sites`:对 `/.xd-pages/api/*` 的请求由 Cindy Desktop 宿主代发,每个请求直接携带 `Authorization: Bearer <connection JWT>`(Cindy auth-server 签发的短时效断言,`typ=connection`,TTL 30 分钟)。`pages-api` 在现有 access key 鉴权之外并行接受这种断言,按凭证形态区分(connection 是标准三段 JWT,access key 是既有 `xdp_` 格式),逐请求验签,不提供换票端点,插件侧不持有任何长效凭证。

验签纪律(实现见 `apps/pages-api/src/connection-assertion.js`):

- 受信 issuer 白名单先于取键:token 的 `iss` 必须命中 `CINDY_CONNECTION_ISSUERS` 配置,才会去 `iss + /.well-known/jwks.json` 拉公钥;staging 同时信 dev 与两个生产 issuer(便于真实登录态联调),production 只信国内 + 海外两个生产 issuer,生产永远不信 dev(renderer 层强制拒绝)。
- JWKS 按 issuer 分桶缓存,按 `kid` 选键;正向缓存 15 分钟 max-age,过期即重拉,保证紧急撤销(kid 从 JWKS 摘除)最多 15 分钟内传播到暖实例;未知 `kid` 重拉带 ≥30 秒冷却,禁止 pin 公钥;重拉失败时旧缓存最多陈旧续用 60 分钟(auth-server 整体故障时签发同样中断,流量在断言 TTL 内自终止,陈旧窗口只覆盖 JWKS 单点故障),超限对外表现为可重试的 503。
- 只收 RS256,显式拒绝 HS256/none;校验 `iss` / `aud`(`CINDY_CONNECTION_AUDIENCE`,当前为 `xd:xd-sites`)/ `typ` / `ctx=org` / `orgSlug` / `exp`、`iat`(±60 秒);断言总有效期(`exp - iat`)上限 31 分钟(契约 TTL 30 分钟 + 签发端取整缓冲;这是签发方声明的纯算术差,不涉及时钟偏移),防 issuer 误配签出长命票;Cindy 侧合法调整 TTL 属契约变更,需同步修改本侧常量。
- 验签失败一律 401 `CONNECTION_ASSERTION_INVALID`(客户端据此重签重试一次);JWKS 拉取故障返回 503;403 留给身份有效但无权限(如 `PAGES_USER_INACTIVE`)。
- 只信契约内 claims:`sub` / `ctx` / `orgSlug` / `email` / `iss` / `aud` / `typ` / `exp` / `iat` / `jti`;payload 里其它字段(role、identities 等)一律不读,尤其不得用于授权判断。

用户落库与权限:

- 账号映射以 `sub`(membershipId)为长期主键,存 `users.cindy_membership_id`;查找顺序是 membershipId 命中 → 规范化邮箱首次对账并绑定 → 新建用户(`created_source=cindy`)。绑定、新建以及验签通过后的身份拒绝(冲突/非 active)都写 `audit_events`,metadata 完整保留契约内 claims(sub/email/orgSlug/iss/aud/jti/iat/exp)作为绑定与拒绝的证据;契约外字段不读也不落。验签失败不产生任何库写入。
- 断言 actor 只持有 `deploy:site`、`read:site`、`rollback:site` scope;不能创建或管理 access key,服务端据此保证 30 分钟断言换不出长效凭证。
- CLI 与 CI 场景继续使用既有 access key 体系,不受影响。
- `pages-api` 的管理 API 不按来源 IP 限制,统一依赖各 handler 的凭证、scope 和 owner/team 校验,并只接受 HTTPS;`pages-router` 继续用独立 allowlist 保护已部署子站,`pages-console` 也暂时保留公司网络门禁。
- `users` 仍是唯一用户表;历史 `created_source=xdmaker` 用户按规范化邮箱在首次断言时补绑 `cindy_membership_id`,不改变 `user_id`。

早期的 XDMaker HMAC S2S 换票通道(`/.xd-pages/api/s2s/*`)从未正式投产,已随本方案落地整体移除;`pages-api` 不再持有任何 S2S shared secret。
