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
