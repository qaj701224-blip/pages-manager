# XD Cell API Boundary

本文定义 XD Cell v2 的 CLI-managed API boundary。它不是 endpoint reference，也不是 CLI 使用指南。

普通用户、AI agent 和 CI 的入口是 `xd-cell` CLI 与 `xd-cell` skill。它们不手写部署 HTTP 请求，不拼接认证 header，不直接构造上传协议。CLI 负责认证、目录识别、打包上传、重试和结果解释。

## 边界结论

- `apps/pages-api` 不公开 `/openapi.json` 或 `/.xd-pages/api/openapi.json`。
- `apps/pages-api/src/openapi.js` 是开发期 API 合约源码，只服务实现、测试和受控内部集成。
- API 文档不复刻不完整 endpoint 清单；需要改 API 行为时，以 handler、`apps/pages-api/src/openapi.js` 和 focused `node:test` 一起更新为准。
- 用户可见发布、状态、访问控制和回滚流程以 CLI help 与 `apps/pages-skill/skill/SKILL.md` 为准。
- v1 `apps/server` 属于 legacy；v1 `/openapi.json` 继续服务旧 `workers.xd.team` 链路，不代表 v2 对外承诺公开 OpenAPI。

## 真相源

| 领域 | 真相源 | 说明 |
| --- | --- | --- |
| 用户和 agent 操作 | `xd-cell` CLI help、`apps/pages-skill/skill/SKILL.md` | 发布、状态、访问控制、回滚和错误处理 |
| API 开发合约 | `apps/pages-api/src/openapi.js`、对应 handler、`node:test` | 开发、测试和受控内部集成，不作为 public route |
| 项目架构入口 | `README.md`、`docs/README.md` | monorepo 架构、文档索引和真相源矩阵 |
| v1 legacy API | `apps/server/README.md`、`apps/server/src/**` | 旧 `workers.xd.team` 行为和 v1 `/openapi.json` |

## 开发规则

- 认证、上传协议、幂等 key、multipart payload 和轮询细节都是 CLI 内部协议，不作为用户或 AI 的手写 API。
- 改 API 行为时，同步 handler、`apps/pages-api/src/openapi.js`、focused `node:test` 和受影响的 CLI/skill 文档。
- 新增或修改用户可见能力时，先确认 CLI help、`apps/pages-skill/skill/SKILL.md`、`README.md`、`docs/README.md` 和本文没有互相漂移。
- 不在公开文档中暴露发布 token、CLI token、cookie、SSO code、session、provider、WFP、slot、dispatch namespace、Cloudflare resource id 或 runtime capability。
- 不为了方便调试把 v2 `/openapi.json` 重新作为 public route 暴露。

## XDMaker 受控凭证交换

XDMaker 的桌面端仍只通过捆绑的 `@xd-cell/cli` 发布，不直接调用部署 HTTP API。为免除一次重复浏览器登录，`xdt-api` 可在服务端以自身 JWT 已背书的飞书登录态调用 `pages-api` 的受控 S2S lane，换取一个用户归属的短期 access key，再原路交给 XDMaker 客户端；客户端不持有 HMAC shared secret，也不能自行调用该 lane。

- S2S 发放与吊销接口属于内部集成面，鉴权使用 HMAC、timestamp、nonce 和 registry，并继续先经过现有 `IP_ALLOWLIST`；不新增 XDMaker 专用 IP allowlist。
- key 使用现有个人 owner-scoped access-key 权限，固定 24 小时 TTL，可在 deploy 事务内首次建个人站点；XDMaker 不获得团队管理或平台 admin 权限。
- `issuedSource=xdmaker_s2s` 的 key 会显示在 Console 的个人 Access Keys 列表中，现有 owner revoke 操作可直接撤销；xdt-api 按 key 或邮箱吊销只影响该来源的 key，并保持幂等。
- 发放时记录 `issuedSessionVersion`。用户发生禁用、离职、封禁或其它明确安全失效事件后，版本变化会立即使旧 S2S key 失效；普通 CLI/Console key 不继承这条 freshness 约束。
- `users` 仍是唯一用户表，飞书 `open_id` 只存 `feishu_open_id`，跨飞书 SSO 与心动 SSO 的关联键是规范化邮箱；新用户标记 `created_source=xdmaker`。

真实 shared secret、xdt-api 出口 CIDR 和轮换操作通过双方受控渠道人工交换，不写入仓库、公开文档、issue、PR、日志或响应。
