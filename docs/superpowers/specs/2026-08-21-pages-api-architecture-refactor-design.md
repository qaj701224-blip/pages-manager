# pages-api 渐进式架构重构设计

## 动机 / 背景

`apps/pages-api` 已经从最初的管理 API Worker 演进为 XD Cell v2 控制面的核心模块。它同时承载公开 API、Console BFF API、内部 service binding API、部署与回滚编排、站点和访问策略、runtime vars/secrets、身份与 access key、资源治理、Webhook、审计、定时清理和部分 v1 迁移能力。

当前实现的安全性、一致性和回归覆盖较好，但代码边界开始阻碍维护：

- `store.js` 约 6800 行并暴露近 150 个异步方法，身份、团队、站点、部署、runtime config、审计、Webhook 和清理 SQL 混在同一个类里；
- `deployments.js` 约 4600 行，在一个模块内处理 HTTP、multipart、授权、幂等、站点解析、Provider、route commit、补偿、恢复、trace 和响应映射；
- `admin.js`、`sites.js` 和 `console.js` 通过互相导入 handler 内部 helper 来复用业务，依赖方向不清晰；
- Public、Console、Admin 对建站、删除、所有权、访问策略和 runtime config 分别实现相似流程，容易产生语义漂移；
- `pages-auth` 直接从 `apps/pages-api/src` 导入 Store 和部门 hydration，实际共享能力没有稳定 package 边界；
- `D1PagesStore` 和 `TestPagesStore` 手工维护两套大规模实现，handler 测试和真实 D1 语义存在长期漂移风险；
- Worker bindings、optional capabilities 和 secret 读取散落在各模块，文档已经出现 `PAGES_AUTH`、legacy CLI JWT 和 Cloudflare zone secret 名称与现状不一致的问题。

本次重构只调整代码和文件结构，不改变运行时产品模型。

## 目标

1. 保持一个 `pages-api` Cloudflare Worker，不拆 Worker，不新增或变更 Cloudflare 资源拓扑。
2. 建立 `transport -> application -> domain` 的单向业务依赖，以及由 composition root 注入的 infrastructure adapters。
3. 将 Public、Console、Admin 相同业务动作收敛到同一个 application use case。
4. 将大型 Store 拆为领域 repository、row mapper 和明确的跨 repository transaction coordinator。
5. 将部署和回滚拆为可独立理解、测试和恢复的显式阶段，不引入通用工作流框架。
6. 模块化配置、Provider、route snapshot、外部集成和可观测性接口，application 不直接依赖 Cloudflare `env`。
7. 通过 workspace shared package 解除 `pages-auth` 对 `pages-api/src` 的直接 import。
8. 保持公开 API、内部 API、D1 schema/migration、状态机顺序、一致性和错误语义兼容。
9. 用静态依赖规则、focused tests、D1 contract、跨 app 回归和全量 CI 验证结构与行为。

## 非目标

- 不拆分 `pages-api`、不新增 Queue、R2、Durable Object、D1、KV、service binding、route 或 Cron。
- 不改变 Worker 名称、域名、dispatch namespace、route snapshot schema 或 Router 读取协议。
- 不改变公开 endpoint、请求格式、响应字段、错误码、HTTP 状态、CLI 行为或 Cindy connection assertion 契约。
- 不修改现有 D1 表结构或重写 migration；若实施过程中发现数据模型问题，另行设计，不混入本重构。
- 不异步化部署，不改变上传 50 MiB 上限，不替换 WFP/ordinary Worker Provider。
- 不引入 DI 框架、ORM、通用 workflow/state-machine 框架或 TypeScript 迁移。
- 不借重构清理无关 legacy 行为；v1 能力只移动到清晰的 integration/governance 边界。

## 硬性兼容约束

### Cloudflare 拓扑

以下 production/staging 拓扑在本次重构中必须保持不变：

- Worker 名称、`main = "src/index.js"` 和公开 routes；
- `PAGES_METADATA` D1 binding；
- `ROUTE_SNAPSHOTS`、`V1_SITES` KV bindings；
- `ROUTE_POINTER_LOCKS` Durable Object binding 和 class/migration；
- `XD_OFFICE_NET` VPC binding；
- `pages-auth -> pages-api`、`pages-console -> pages-api` 和 v1 hostname claims service bindings；
- `*/15 * * * *` cleanup Cron；
- production/staging 的 domain、namespace、D1/KV/DO 物理隔离。

重构可以增加 workspace package 依赖和改变 Worker bundle 内部模块图，但不得要求新增 runtime binding 或 deployment secret。

### API 与状态语义

- `apps/pages-api/src/openapi.js` 继续是开发期 API 合约入口；可以组合子模块，但路径和导出保持稳定。
- `src/index.js` 继续导出默认 Worker 和 `RoutePointerDO`。
- 所有公开、Console 和 internal path、method、认证边界与响应保持兼容。
- deployment/rollback 的 idempotency、status transition、trace、Provider operation、route CAS、policy/runtime config lease、补偿、failure recovery 和 cleanup enqueue 顺序保持不变。
- D1 仍是权威状态；KV route pointer 仍是 Router 可见提交点；DO 仍负责 pointer 单调写入与 recovery marker。
- `ctx.waitUntil` 副作用仍不阻断已经提交的用户结果。

## 目标架构

### 目录结构

```text
apps/pages-api/src/
├── index.js                         # composition root 与 Worker export
├── transport/
│   ├── router.js                    # 顶层 path/host 分发
│   ├── public/
│   │   ├── sites-handler.js
│   │   ├── deployments-handler.js
│   │   ├── teams-handler.js
│   │   ├── access-keys-handler.js
│   │   └── whoami-handler.js
│   ├── console/
│   │   ├── sites-handler.js
│   │   ├── teams-handler.js
│   │   ├── admin-handler.js
│   │   └── webhooks-handler.js
│   ├── internal/
│   │   ├── identity-handler.js
│   │   └── hostname-claims-handler.js
│   └── shared/
│       ├── http.js
│       ├── authenticate.js
│       ├── api-errors.js
│       └── request-context.js
├── application/
│   ├── ports/                       # application 使用的最小 I/O 契约
│   ├── sites/
│   ├── deployments/
│   ├── runtime-config/
│   ├── identity/
│   ├── teams/
│   └── governance/
├── domain/
│   ├── sites/
│   ├── deployments/
│   ├── runtime-config/
│   ├── identity/
│   └── shared/
├── infrastructure/
│   ├── config/
│   ├── store/
│   │   ├── repositories/
│   │   ├── transactions/
│   │   └── row-mappers/
│   ├── providers/
│   ├── route-snapshots/
│   ├── observability/
│   └── integrations/
│       ├── org-directory/
│       ├── slack/
│       ├── webhooks/
│       └── legacy-v1/
├── openapi.js                       # 稳定合约入口，可组合 contracts/openapi/*
├── public-docs.js                   # 稳定文档入口，可组合 contracts/docs/*
└── compatibility/                  # 迁移期 facade，仅临时存在
```

最终目录可以根据实际依赖合并很小的模块，但必须保持本设计定义的层级和依赖方向。不能为了匹配目录树制造一函数一文件或无业务价值的 wrapper。

### 依赖方向

```text
transport ------------> application ------------> domain
     |                       |                       ^
     |                       v                       |
     +--------------------> ports <----- infrastructure

index.js/composition root 负责创建 infrastructure adapter 并注入 use case/handler。
```

具体规则：

- `domain/**` 只依赖 domain、自身纯 helper 和稳定 workspace protocol package；不得导入 `transport`、`application`、`infrastructure`、Cloudflare binding 或 app 文件。
- `application/**` 可以导入 domain 和 `application/ports`；不得读取 `env`，不得导入 D1/KV/DO/WFP client、HTTP `Request/Response` 或 transport。
- `transport/**` 负责 host/path/method、认证、请求解析和响应映射；不得保存 SQL、Provider 编排或跨 transport 复用业务 handler。
- `infrastructure/**` 实现 ports，允许依赖 domain/shared package；不得导入 transport handler。
- `index.js` 是唯一知道完整 runtime `env`、配置、adapter 和 handler 组合关系的生产入口。
- Public、Console、Internal transport 互不导入；共享业务必须下沉 application，共享 HTTP helper 放 `transport/shared`。
- 以上规则通过 ESLint restricted imports 和 focused architecture test 双重锁定。

不使用 class-based DI container。ports 使用普通对象、factory 和 JSDoc 描述，例如：

```js
export function createDeleteSite({ sites, routeSnapshots, cleanupTasks, events, clock }) {
  return async function deleteSite(command) {
    // application orchestration
  };
}
```

### Composition root 与配置

`src/index.js` 最终只承担：

1. 读取基础环境并 fail closed；
2. 创建 Store、Provider、route snapshot、observability 和 integration adapters；
3. 创建 application services；
4. 创建 transport router；
5. 转发 `fetch`/`scheduled`；
6. 导出 `RoutePointerDO`。

配置按 capability 拆分：

- `readApiConfig`：environment、公开 origin、site suffix；
- `readWfpConfig`/Provider config：Cloudflare account/token/API base、dispatch namespace、compatibility date；
- `readIdentityConfig`：access key peppers、Cindy issuers/audience、CLI key TTL；
- `readRuntimeConfig`：site secret key、request/runtime hash pepper；
- `readOrgDirectoryConfig`：XDS token、VPC capability；
- `readLegacyConfig`：v1 KV/zone/保留 Worker；
- `readWebhookConfig`/`readAlertConfig`：URL encryption、DNS resolver、Slack webhook。

基础配置错误继续让 Worker 返回 `API_ENV_INVALID`。可选 capability 只在对应 use case 被调用时返回现有的 capability-specific 错误，不能因为 v1/Slack/Webhook 可选配置缺失而让所有 API 启动失败。

配置模块返回最小值对象，application 不接收完整 `env`。

## Application 与 Domain 设计

### Transport 责任

每个 transport handler 只做：

- path、method、host 和 content type 判定；
- Public access key/Cindy assertion 或 Console/internal capability 的身份验证；
- 将输入转换为 command/query DTO；
- 调用一个 application use case；
- 将结果或稳定错误映射为当前 API 响应；
- 追加已有 response headers，例如 deployment trace ID。

HTTP 错误文案不能散落在 application。按领域维护响应 catalog，保持现有 `code`、`message`、`action`、status。domain error 只包含稳定 code 和安全 details；transport mapper 决定公开文本。

### Sites 与 Runtime Config

需要收敛为共享 use case 的动作包括：

- create site；
- delete site；
- transfer owner；
- update access policy/visibility/ACL；
- put/delete runtime var；
- put/delete site secret；
- enqueue deleted-site resources；
- commit/compensate route snapshot。

Public、Console、Admin 的区别由 command 中的 actor/capabilities 和 transport DTO 表达，不通过调用不同业务 helper 表达。Platform Admin 可以拥有额外 capability，但仍调用同一个核心 use case。

访问策略 mutation 的一致性边界保持：

1. 获取 renewable site policy/commit lease；
2. 读取并验证 expected authority state；
3. 原子更新 D1 site/ACL/route authority；
4. 写 immutable snapshot 和 monotonic pointer；
5. pointer 写失败时按当前 CAS 条件补偿 D1；
6. 补偿失败返回现有 repair-required 错误并保留审计证据。

### Deployments 与 Rollback

不引入通用 state machine。`deploy-site.js` 和 `rollback-site.js` 是显式 use case，依次调用窄阶段函数：

```text
intake / payload validation       transport + pure domain validators
auth and site resolution         application/sites port
idempotency / deployment record  deployment repository/transaction
runtime config snapshot          runtime-config application service
provider upload / verify         execution provider port
version create                   deployment transaction
site commit lease / OfficeNet    policy + provider ports
route activation                 atomic route transaction
route snapshot                   route snapshot port
terminal persistence             deployment repository
cleanup / webhook                task scheduler + application ports
recovery / compensation          explicit recovery module
```

阶段共享一个 application context，只包含 actor、environment、IDs、time、trace context 和已经解析的业务数据，不包含 `Request`、`Response` 或完整 `env`。

迁移必须保持当前 operation order 和 failure precedence。拆分阶段时先 characterise 当前输出与状态副作用，再移动代码；不能在同一个提交中同时重排阶段或“简化”补偿语义。

### Admin 与 Governance

`admin.js` 拆为：

- dashboard/query projections；
- deployment trace/audit query；
- public exposure management；
- WFP orphan inventory/backfill；
- normal Worker inventory/retirement；
- cleanup task runner；
- v1 site inventory/retirement；
- admin site/team/user mutations。

Platform Admin transport 负责强制管理员身份，application governance service 负责资源归属、环境、保留名单、active reference 和 destructive precondition。Cron 与 Admin 手动 run-due 调用同一个 cleanup application service。

## Store 设计

### Composite facade 与 repositories

第一阶段保留 `createPagesStore()` 和 `D1PagesStore` 对外方法，内部逐领域委托：

```text
infrastructure/store/
├── create-store.js
├── repositories/
│   ├── identity-repository.js
│   ├── teams-repository.js
│   ├── sites-repository.js
│   ├── routes-repository.js
│   ├── deployments-repository.js
│   ├── runtime-config-repository.js
│   ├── access-keys-repository.js
│   ├── audit-repository.js
│   ├── webhooks-repository.js
│   └── cleanup-repository.js
├── transactions/
│   ├── create-site.js
│   ├── v1-takeover.js
│   ├── update-site-policy.js
│   ├── activate-route.js
│   ├── transfer-owner.js
│   └── runtime-config-mutation.js
└── row-mappers/
```

Repository 只包含单一领域查询和更新。跨表原子行为使用命名 transaction coordinator，并继续通过 D1 `batch()`、CAS guard statements 和现有 lease 语义实现。不能让 application 通过多个独立 repository call 重新拼出原本原子的操作。

Store facade 在迁移期间代理原方法，保证 handler 和 tests 可逐步迁移。所有调用方切到窄 ports 后删除 facade 或将其缩到 composition helper；不保留另一个永久 God object。

### Test Store 退出策略

不一次性删除 `TestPagesStore`。迁移顺序为：

1. 为每个 repository/transaction 建立 SQLite-backed D1 contract test；
2. application use case 使用只实现其 ports 的小 fake；
3. route-level tests 保留组合 test harness；
4. 迁移现有 handler tests 后，拆除对应 TestPagesStore 方法；
5. 最终删除大而全的 TestPagesStore，或仅保留由小 fake 组合的无业务逻辑 harness。

fake 不能重新实现 SQL/CAS/transaction 语义；这类语义只能由 D1 contract test 证明。

## 跨 app 共享边界

新增纯代码 workspace package `packages/pages-metadata`，npm 名称 `@xd/pages-metadata`。它不对应 Worker，也不声明 Cloudflare 资源。

第一版 package 只承载 `pages-auth` 与 `pages-api` 真正共享的身份元数据能力：

- user create/get/find/upsert 和 Cindy/Feishu identity binding；
- SSO employee status merge/session version 规则；
- department path normalization、department team identity 和 hydration orchestration；
- 以上能力需要的窄 D1 repository 和 ports。

package 不承载部署、站点、route、runtime config、Provider 或 Console/Admin HTTP 逻辑。

`pages-api` 的 identity repository/facade 组合或委托该 package；`pages-auth` 直接依赖 package，而不再 import `../../pages-api/src/*`。两者继续使用现有各自的 `PAGES_METADATA` 和 `XD_OFFICE_NET` bindings，因此不改变 Cloudflare 拓扑。

如果某个 department transaction 与 team/site authority 无法在不破坏原子性的前提下独立，可以把该命名 transaction 一并作为 package 的受限 identity metadata 能力，而不是让两个 app 分别复制 SQL。这是只服务部门身份一致性的显式例外，不表示 package 可以承载通用 site/team 管理能力。package API 必须保持窄，不能把完整 Pages Store 暴露给 pages-auth。

## Infrastructure Ports

application 依赖的主要 ports：

- `identityRepository`
- `teamRepository`
- `siteRepository`
- `deploymentRepository`
- `runtimeConfigRepository`
- `auditRepository`
- `cleanupRepository`
- `siteTransactions`
- `deploymentTransactions`
- `executionProvider`
- `routeSnapshotStore`
- `orgDirectory`
- `webhookDispatcher`
- `alertSink`
- `taskScheduler`
- `clock`
- `idGenerator`

这些是按 use case 注入的最小对象，不要求每个 use case 接收所有 ports。Provider 返回继续使用现有 normalized result/error；Cloudflare request/response 细节只存在 infrastructure。

`ctx.waitUntil` 适配为：

```js
const taskScheduler = {
  defer(promise) {
    ctx.waitUntil(promise);
  },
};
```

scheduled handler 直接调用同一个 cleanup use case，不伪造 HTTP request。

## 错误、日志与安全

- 公共 error code/status/message/action 完全保持，新增内部层不得改变 fallback precedence。
- domain/application error details 采用闭合白名单；原始 D1、Cloudflare、JWKS、XDS 或 webhook error 不得直接进入响应、审计或日志。
- deployment trace、audit sanitizer、runtime config diagnostics 和 Provider diagnostics 在迁移时作为 observability ports 组合，不能降级现有证据。
- secret、access key、session、Assets JWT、Cloudflare token、内部资源 ID 和 webhook URL 继续遵守现有脱敏边界。
- internal API 继续依赖 service binding hostname/capability，不能因 transport 重排暴露到 public host。
- environment 必须在 composition/config、repository queries、Provider config 和 route snapshot 四层保持 fail closed。

## 渐进迁移顺序

### 阶段 0：基线与结构护栏

- 记录现有 focused tests、全量测试和 lint 基线；
- 增加层级 import 规则和 architecture test；
- 建立 runtime config/binding inventory 测试；
- 修正 `PAGES_AUTH`、legacy CLI JWT 和 zone secret 的文档漂移；
- 不移动业务逻辑。

### 阶段 1：Composition root、Router 与 Config

- 抽出 transport router；
- 将重复的 Store 创建和 store-unavailable 响应集中到 composition/request context；
- 拆 capability config readers；
- 保持旧 handler 作为 adapter target；
- `index.js` 缩为组装入口。

### 阶段 2：Store repositories 与 transactions

- 先抽纯 row mappers/query repositories；
- 再按 identity、sites/routes、deployments、runtime config、governance 拆分；
- 每个 transaction 迁移时先建立 D1 contract；
- facade 委托新实现，调用方暂不需要同时修改。

### 阶段 3：共享 Metadata package

- 从已经拆出的 identity/department repository 提取 `@xd/pages-metadata`；
- pages-api 使用 package adapter；
- pages-auth 改用 package；
- 删除跨 app import exception 和 `@xd/pages-api` 测试依赖；
- 跑 OAuth、CLI login、Console session、Cindy assertion 和 department team 回归。

### 阶段 4：Sites 与 Runtime Config application services

- 先收敛纯校验和 actor capability；
- 再迁移 create/delete/transfer；
- 迁移 access policy snapshot/compensation；
- 迁移 vars/secrets Provider sync；
- Public、Console、Admin transport 分批切换到同一 use case；
- 删除跨 handler helper import。

### 阶段 5：Deployments 与 Rollback

- 抽 multipart/intake response mapping；
- 抽 site resolution/idempotency；
- 抽 runtime config stage；
- 抽 Provider upload/verify；
- 抽 version/route commit；
- 抽 compensation/recovery/terminal persistence；
- 每次移动一个阶段并运行 deployment timeline、failure recovery、rollback、WFP、slot 和 route snapshot tests。

### 阶段 6：Admin 与 Governance

- 拆 read projections；
- 拆 exposure mutation；
- 拆 cleanup runner，并让 scheduled/Admin 共用；
- 拆 Worker inventory/retirement；
- 将 v1 集中到 integration + governance；
- 保留 destructive safety checks 和审计顺序。

### 阶段 7：移除 compatibility 与同步真相源

- 删除旧 facade、dead exports 和跨 handler imports；
- 拆分/删除大而全 TestPagesStore；
- 保持 `openapi.js`、`public-docs.js` 稳定入口并同步子模块；
- 更新 `docs/api-boundary.md`、架构和运维文档；
- 完成 production/staging template diff 审计和全量验证。

每个阶段必须是可独立 review、可独立回滚的行为保持变更。不得为了减少提交数把 Store、application service 和 transport 切换塞入一个大提交。

## 验证策略

### 静态结构验证

- ESLint 禁止逆向层级 import、跨 transport import 和跨 app `src` import；
- architecture test 扫描 production imports，防止通过 relative path 绕开 ESLint pattern；
- runtime binding inventory 对照 production/staging templates 和 capability readers；
- `git diff --check`；
- 检查 `.github/workflows` 没有新增 production 自动部署触发。

### 行为验证

每个迁移单元至少覆盖：

- 原 endpoint 的成功响应、错误码、状态、action 和 headers；
- authorization 与 environment isolation；
- D1 authority mutation 和 transaction rollback；
- route snapshot/pointer 提交与补偿；
- Provider 调用顺序、diagnostics 和 cleanup；
- trace/audit/webhook 的安全输出；
- injected failure 和并发 CAS/lease 行为。

### 测试层级

1. domain：纯规则测试；
2. application：窄 fake ports 测 orchestration；
3. repository/transaction：SQLite-backed D1 contract；
4. transport：route matrix、auth、request/response contract；
5. integration：pages-api + router + kv-gateway、pages-auth OAuth/CLI、pages-console BFF；
6. repository 全量：`pnpm lint`、`pnpm test`。

最终至少执行：

```bash
node --test "apps/pages-api/src/**/*.test.js"
node --test "apps/pages-auth/src/**/*.test.js"
node --test "apps/pages-console/src/**/*.test.js"
node --test "apps/pages-router/src/**/*.test.js"
node --test "packages/pages-metadata/src/**/*.test.js"
pnpm lint
pnpm test
git diff --check
```

如果 Node glob 在目标环境未匹配文件，应使用仓库根 `pnpm test` 和显式 focused file list，不把“未运行任何测试”当作成功。

## 完成标准

满足以下条件才算本重构完成：

- `src/index.js` 是薄 composition root，不包含领域分支；
- `deployments.js`、`store.js`、`sites.js`、`admin.js` 已删除，或仅作为不超过约 250 行的临时兼容入口且存在明确移除点；最终交付不得保留永久 God facade；
- 新生产模块通常不超过约 800 行；超过 1000 行的手写业务模块必须在设计审查中说明为何仍只有单一职责。`openapi.js`、schema snapshot 和测试 fixture 不受该建议阈值约束；
- Public、Console、Admin 的建站、删除、owner transfer、访问策略、vars 和 secrets mutation 可证明调用同一 application service；
- application 不读取 Cloudflare `env`，不导入 transport/infrastructure，不处理 HTTP；
- Store 已按 repository/transaction 拆分，跨表原子语义由 D1 contract 覆盖；
- `TestPagesStore` 不再作为一份完整业务实现与 D1 Store 并行维护；
- `pages-auth` 不再 import `apps/pages-api/src`，仓库不存在 production 跨 app source import exception；
- Worker/Cloudflare resource topology、D1 schema/migrations、公开 API 和 route snapshot schema 无变化；
- OpenAPI、CLI/skill 边界和当前行为一致；
- focused tests、跨 app tests、`pnpm lint`、`pnpm test`、`git diff --check` 全部通过。

## 风险与缓解

### 行为保持重构产生隐式语义变化

缓解：先锁定 characterisation tests；每次只迁移一个行为单元；不在移动代码时重排状态机或错误优先级。

### Store 拆分破坏事务原子性

缓解：跨表行为必须进入命名 transaction coordinator；D1 contract 测试验证 late-statement failure rollback、CAS loss 和并发 lease。

### ports 和目录造成过度抽象

缓解：只为两个以上调用方、外部 I/O 或需要独立 failure injection 的边界建立 port；纯内部 helper 不建立 interface；不使用 DI framework。

### shared package 变成新的 God package

缓解：`@xd/pages-metadata` 仅包含身份/部门共享能力；package export 采用显式入口；禁止依赖部署、站点、Provider 和 HTTP handler。

### 长期保留兼容 facade

缓解：facade 只允许在当前迁移阶段存在；每个 facade 有删除测试/搜索条件；完成审计把永久 God facade 视为未完成。

### 大规模文件移动导致 review 困难

缓解：先机械移动并验证，再改变调用方向；避免同一提交同时移动、重命名和改变业务逻辑；每阶段提供 changed-file map 和测试证据。

## 回滚

- 每个阶段保持独立提交，可按阶段 revert；
- compatibility facade 保证中间状态仍由原入口提供行为；
- 不修改 D1 schema 和 Cloudflare 拓扑，因此回滚不需要数据迁移或资源回收；
- shared package 回滚时两个 app 可恢复到上一个已验证 import，但不得长期保留双实现；
- staging 按现有 workflow 验证，production 仍只允许人工触发部署。

## Self-review Checklist

- [x] 不拆 Worker、不新增或改变 Cloudflare 资源。
- [x] 公开 API、内部 API、数据和 route commit 语义保持兼容。
- [x] 定义 transport/application/domain/infrastructure 单向边界。
- [x] 定义 Store repository、transaction 和 Test Store 退出策略。
- [x] 定义 Public、Console、Admin 复用 application service 的方式。
- [x] 定义 deployments、sites、admin 热点拆解路径。
- [x] 定义 pages-auth 跨 app import 的 shared package 解法。
- [x] 定义配置、Provider、route snapshot、observability ports。
- [x] 定义分阶段迁移、验证、完成审计和回滚方式。
- [x] 没有引入与目标无关的产品能力、资源或框架。
