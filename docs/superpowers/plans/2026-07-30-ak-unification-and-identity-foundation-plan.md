# AK 统一与身份模型地基实施方案

日期:2026-07-30。状态:P0 进入实施;P1 为设计概述,待 P0 完成后另行派发。

背景讨论结论(已与平台 owner 对齐):

- 平台编程凭证统一为 access key 一种实体;CLI token(无状态 JWT)是历史特例,应废弃。
- CLI 签发的 key:scope 为 `['*']`,TTL 默认 1 年,支持配置为永不过期;除主动撤销或 sessionVersion 失效外持续有效。
- 用户/团队/部门多来源身份模型(P1-P3)与 AK 统一解耦,先做 AK;唯一前置承诺是 `users.user_id` 永不重键。

## P0:AK 统一(本期实施)

### 目标

`xd-cell login` 改为签发 `issued_source='cli_login'` 的个人 access key,废弃 JWT 形态 CLI token 的签发;pages-api 统一验证路径(过渡期双接受);补齐撤销链路(CLI logout、浏览器 logout)。

### 兼容性承诺(硬性要求)

1. 已登录浏览器用户零影响:auth_session / site_session / console_session 机制不动。
2. 已持有 CLI token(JWT)的用户:过渡期内继续有效直至自然过期(≤30 天),不强制重新登录;`authenticateCliToken` 分支保留,45 天后另行 PR 删除。
3. 旧版本 CLI 无需升级即可工作:CLI login poll 的响应契约(字段名、结构)保持不变,旧 CLI 透明拿到 access key 明文并以 `Authorization: Bearer` 发送,服务端按 token 格式路由(`parseAccessKeyPlaintext` 命中则走 access key 分支)。
4. CLI 侧凭证存储格式不变(keychain / credentials.json)。

### 关键设计决策(实施时不可更改)

**D1:cli_login key 认证后的 actor 类型必须是 `user`,不是 `access_key`。**

这是整个兼容性的关键。现在 CLI token 认证产出 `{type:'user', scopes:['*'], source:'cli'}`(`apps/pages-api/src/auth.js:48-60`),大量授权分支按 actor type 分流(`store.getSiteForUser` 的 user/access_key SQL 分支、`access-keys.js:119-121` 禁止 access_key actor 创建 key、站点转移限制等)。若 cli_login key 产出 access_key actor,CLI 将丧失创建 access key、按成员身份看站点等能力,属于行为回归。

实现:`authenticateAccessKey` 中当 `accessKey.issuedSource === 'cli_login'` 时,返回与现有 CLI token 相同形状的 actor:`{type:'user', actorId:userId, userId, email, name, tokenId: accessKey.id, scopes:['*'], source:'cli'}`。其余来源的 key 行为完全不变。

**D2:签发链路为 pages-auth → pages-api 内部端点,poll 契约不变。**

- pages-auth 新增 `PAGES_API` service binding(staging + production 两套 wrangler 模板同步,不提交真实 id)。
- pages-api 新增内部端点 `POST https://pages-api.internal/.xd-pages/internal/cli-access-keys`,body:`{ userId, cliLoginId, environment }`。沿用 `internal.js` 现有 hostname 判定与 environment 一致性校验模式(参考 `internal.js` 中 hydrate-user-department 的 `PAGES_ENV` mismatch 403)。校验用户存在且 `employeeStatus === 'active'` 后创建 key,明文仅在响应中返回一次。
- key 属性:`owner_type='user'`、`issued_source='cli_login'`、`scopes=['*']`、`site_id=NULL`、`issued_session_version=user.sessionVersion`、`name` 含 cliLoginId 前缀便于审计。**无需 D1 migration**:`issued_source` / `issued_session_version` 列已由 0014 提供,`expires_at` 本就可空。
- poll 流程改为**先 consume 再创建**(顺手修掉现有"先签 token 后 consume"导致并发 poll 可各领一份 token 的问题,`cli-endpoints.js:72-99`):consume 成功 → 调内部端点 → 明文放入 poll 响应原 token 字段返回。若 consume 后创建失败,返回明确错误(如 `CLI_LOGIN_EXCHANGE_FAILED`,action 提示重新 `xd-cell login`),不回滚 consume。

**D3:TTL 策略。**

pages-api 新增 var `CLI_ACCESS_KEY_TTL_SECONDS`,默认 `31536000`(1 年);显式配置为 `0` 表示永不过期(`expires_at = NULL`)。该策略仅作用于 `issued_source='cli_login'` 的内部创建路径;公开 API 创建 key 的"默认 3 个月、上限 1 年"校验不变,公开 API 仍禁止 `*` scope。

**D4:sessionVersion 绑定生效。**

cli_login key 写入 `issued_session_version`,`auth.js:92-103` 现有校验自动生效——管理员改用户状态(bump sessionVersion)即可令所有 CLI key 失效,补上"踢不下线"缺口。

**D5:撤销链路。**

- 新增 `DELETE /v2/access-keys/current`(命名可按 openapi 风格微调):actor `source==='cli'` 时撤销 `actor.tokenId` 对应 key;持 legacy JWT 调用时幂等返回成功(无实体可撤)。CLI `logout` 先 best-effort 调它,再删本地凭证;输出文案如实反映服务端撤销结果。
- pages-auth 浏览器 `/logout`(`apps/pages-auth/src/index.js:76-87`)接线 `AuthSessionDO /revoke`(撤销代码已存在,`do-storage.js:185-192`,只缺调用),再清 cookie。
- console/API 的 access key 列表需包含 cli_login key 并透出 `issuedSource` 字段,复用现有撤销能力;console UI 仅做最小展示适配。

**D6:legacy 分支保留 + 打点。**

`authenticateCliToken` 保留,认证成功时记一条可观测标记(审计事件或受控日志,遵守 ADR-0002 的 allowlist 投影,不落 token 本体),用于过渡期结束前确认存量流量归零。

### 改动面

- `apps/pages-api`:`internal.js`(新内部端点)、`access-keys.js`(cli_login 创建路径、TTL 策略、current 撤销)、`auth.js`(D1 actor 映射、D6 打点)、`openapi.js`(新撤销端点)。
- `apps/pages-auth`:`cli-endpoints.js`(poll 改造)、`index.js`(logout 接线)、wrangler staging/production 模板(PAGES_API binding)、CLI 确认页文案(`cli_token` 字样 → access key 语义)。
- `apps/pages-cli`:`commands/auth.js`(logout 调撤销;status 可选透出凭证类型)。
- `apps/pages-skill` / `docs/api-boundary.md` / CLI help:与新行为同步。
- 测试:每个行为变更配 focused `node:test`(见验收清单)。

### 验收清单

1. 新登录:`xd-cell login` 得到 `xdp_` 前缀 key,`whoami`、部署、创建 access key 等全链路行为与改造前一致(D1 actor 等价性)。
2. 兼容:构造未过期 legacy CLI token JWT 仍可通过认证;带 `X-Pages-Token` 仍 400。
3. TTL:默认 1 年 `expires_at`;var 配 `0` 时 `expires_at IS NULL`;公开创建 API 上限校验不受影响。
4. 撤销:console/API 撤销 cli_login key 后请求 401;`xd-cell logout` 后服务端 key `revoked_at` 非空;浏览器 logout 后 AuthSessionDO 记录 revoked、auth session 快路径不再命中。
5. 踢下线:bump 用户 sessionVersion 后 cli_login key 返回 `ACCESS_KEY_SESSION_STALE`。
6. 并发 poll:同一 login 事务两个并发 poll 至多一个拿到 key。
7. `pnpm lint`、`pnpm test` 全绿;staging/production wrangler 模板同步且无真实 secret。

### 明确不做(边界)

- 不删 legacy cli_token 分支(独立后续 PR)。
- 不动身份模型(不建 user_identities 等表)、不动 pages-router / visibility / ACL。
- 不做内部端点 shared-secret 加固(已知问题 A6,独立项)。
- 不改 `updateAccessKeyLastUsed` 同步写(已知问题 B5,独立项)。
- 不触碰部署 workflow 的自动触发语义。

## P1:身份模型地基(概述,P0 后派发)

零行为变化的建模层:

1. migration 0016:`user_identities(user_id, provider, external_id, linked_at)`(唯一索引 provider+external_id,回填 xd_sso)、`user_departments(user_id, source, department_path, source_department_id, is_primary, synced_at)`(回填 xds)、`team_sources(team_id, source, external_ref, synced_at)`(回填部门团队折叠路径);`schema.js` 与 `schema.test.js` 同步。
2. `upsertUserFromSso` 重构为 provider adapter 入口(行为保持)。
3. 修复 XDS hydration 失败清空 `users.department_path` 的问题(失败仅更新 `department_checked_at` 节流,保留旧值)——此项为 P1 中唯一的行为变化,方向 fail-open→保留既有授权,需单独测试。
4. `users.department_path` 保留为主投影,所有消费方(session claims、团队映射)不变。

P2(权威矩阵:status/部门权威、自动成员默认 admin 复审)与 P3(飞书来源接入)依赖产品决策,另行立项。
