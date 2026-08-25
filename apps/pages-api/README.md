# pages-api 内部架构

`apps/pages-api` 是 XD Cell v2 的管理 API Worker。它负责身份与权限校验、站点和团队管理、部署与回滚编排、路由提交、runtime config、资源治理、审计和 Webhook；D1 是管理面权威状态，Router 消费的 KV route pointer 是访问面可见提交点。

本文只描述当前代码边界。公开 API 合约以 [`src/openapi.js`](./src/openapi.js) 为准，Cloudflare 资源和部署配置以 [`wrangler.production.template.toml`](./wrangler.production.template.toml)、[`wrangler.staging.template.toml`](./wrangler.staging.template.toml) 和 v2 部署 workflow 为准。

## 分层与请求流

```text
index.js / outer adapters
        |
        v
transport --------------> application --------------> domain
    |                          |
    | creates/adapts ports     | depends on narrow ports
    v                          v
infrastructure -----------> Cloudflare / external services
```

- `src/index.js` 是薄运行时入口：读取基础配置，创建 Store、HTTP router 和 scheduled handler，并保持默认 Worker 与 `RoutePointerDO` export。
- `src/transport/` 负责 host/path/method、HTTPS、认证入口、请求解析、响应和稳定错误映射。Public、Console、Internal lane 不互相调用业务 handler；共享 HTTP/adapter 代码放 `transport/shared`。
- `src/application/` 负责用例编排。它只依赖 domain 和窄 ports，不读取完整 `env`，不处理 `Request`/`Response`，不导入 transport 或 infrastructure。
- `src/domain/` 保存无 I/O 的业务规则和状态判断，不依赖其它层或 Cloudflare runtime。
- `src/infrastructure/` 实现 D1 repository/transaction、配置 reader、Provider、route snapshot、cleanup 和外部集成 adapter。
- composition 只发生在外层入口和 transport adapter；application 接收已经组装好的 port，不自行创建 D1、KV、DO 或 Provider client。

部分未参与本轮机械迁移的稳定协议、认证和集成 adapter 仍位于 `src/*.js`。它们不是新增业务编排的落点；新逻辑应进入上述四层，现有 transport lane 也不得通过 root handler 复用其它入口的业务。

## Store 与一致性边界

`src/infrastructure/store/create-store.js` 创建 `D1PagesStore`，并从以下模块组合其能力：

- `repositories/`：单领域 D1 查询和更新；
- `transactions/`：跨表原子操作、lease 和 CAS；
- `row-mappers/`：无 I/O 的行映射；
- `@xd/pages-metadata`：`pages-api` 与 `pages-auth` 共用的身份 metadata 和部门 hydration 数据层。

跨表不变量必须保留在命名 transaction 中，application 不得用多个 repository call 重拼原子操作。站点策略、部署和回滚仍遵循 D1 authority、lease/CAS、immutable route snapshot、monotonic pointer 和显式补偿语义。

站点展示名称与 canonical slug 由 metadata application use case 统一修改。slug rename 在 D1 中原子维护 canonical route、hostname claim 和不可变 `dataNamespace`，再写入 schema v4 serve snapshot 并清理旧 hostname pointer；它不创建 deployment/version，也不保留旧 URL 跳转。旧 pointer 确认删除后开始 5 分钟 reuse hold，到期后旧 slug 可由其它站点使用。Public、Workspace Console 与 Admin Console 都走该 use case；受控部署集成也可在 multipart metadata 中显式传 `title`，省略时不修改既有名称，字符串会规范化后设置，`null` 会清空。当前 `xd-cell` CLI 不发送 `title`。`SITE_METADATA_MUTATIONS_ENABLED` 在两个环境模板中默认启用，仍可按环境改为 `false` 紧急止损；关闭后只拦截 mutation 和显式携带 `title` 的部署，不影响省略 `title` 的既有部署、metadata 读取、兼容 reader/writer 或 reconciliation。缩略图与 R2 不在当前能力范围内。

测试不维护第二套完整 Store。`test-support/pages-store-fixture.js` 使用真实 SQLite-backed D1 fixture 验证 repository、transaction 和 handler 行为；窄 application 单测可以按 port 注入局部 fake。

## 依赖与影响面

代码直接依赖的 workspace package 包括：

- `@xd/pages-metadata`：共享身份 metadata 与部门 hydration；
- `@xd/pages-access-policy`、`@xd/pages-runtime-protocol`：访问策略和 Router runtime 协议；
- `@xd/wfp-client`：Workers for Platforms API client；
- `@xd/org-directory`：组织目录 client；
- `@xd/worker-kit`：Worker 公共能力。

运行时依赖包括 `PAGES_METADATA` D1、`ROUTE_SNAPSHOTS` / `V1_SITES` KV、`ROUTE_POINTER_LOCKS` Durable Object、可选 `XD_OFFICE_NET` VPC binding，以及按 capability 读取的 Cloudflare、Webhook、Slack 和组织目录配置。binding、secret 和环境隔离的完整清单以 [资源与部署](../../docs/operations/resources-and-deployment.md) 为准，不在本文复制值或资源 ID。

| 改动区域                             | 主要影响                                             | 必须联动验证                                           |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| transport / 认证 / response mapper   | CLI、Cindy、Console BFF、internal caller             | OpenAPI、稳定 error/status、HTTPS 与认证边界           |
| application / domain                 | Public、Console、Admin 对同一业务动作的语义          | 共享 use case、授权、幂等、补偿和 focused tests        |
| Store repository / transaction       | pages-api D1 行为；身份 metadata 还会影响 pages-auth | D1 contract、migration/schema 无漂移、跨 app 回归      |
| deployment Provider / route snapshot | 用户 Worker、pages-router 可见路由和回滚             | Provider 顺序、lease/CAS、snapshot/pointer、recovery   |
| config / Wrangler / workflow         | staging 与 production 资源隔离和部署安全             | binding inventory、无资源串用、production 仍仅手动部署 |
| 公开 API 行为                        | CLI、skill 和受控内部集成                            | `src/openapi.js`、CLI help、skill 和 API 边界文档同步  |

## 扩展规则

新增或修改能力时：

1. HTTP 路由、输入解析和公开错误放在对应 transport lane。
2. 跨 repository、Provider 或 snapshot 的业务流程放在 application use case，并只声明所需的窄 port。
3. 无 I/O 的授权、状态和校验规则放在 domain。
4. SQL、Cloudflare binding、Provider client 和外部服务调用放在 infrastructure。
5. Public、Console、Admin 的同一业务动作复用同一 application service；差异只通过 actor/capability DTO 和 response mapper 表达。
6. 跨 app 共享代码进入 `packages/`，禁止 production app 直接 import 其它 app 的 `src`。
7. 不改变 API 行为时，`src/openapi.js`、CLI 和 skill 应保持无 diff；改变行为时必须同步合约、测试和对应真相源。

依赖方向由 `tests/pages-api-architecture.test.js` 和 ESLint 同时约束。例外不能通过相对路径、root handler 或跨 transport lane 绕过。

## 验证

从仓库根目录运行：

```bash
node --test apps/pages-api/src/**/*.test.js
node --test apps/pages-auth/src/**/*.test.js
node --test packages/pages-metadata/src/**/*.test.js
node --test tests/pages-api-architecture.test.js apps/pages-api/src/config-inventory.test.js
pnpm lint
pnpm test
```

涉及 Console、Router、公开 API、Cloudflare 配置或 workflow 时，还要运行对应跨应用测试并人工核对 production/staging template、D1 schema/migrations、route snapshot schema 和 production 手动部署边界。
