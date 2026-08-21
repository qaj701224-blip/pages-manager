# pages-api 渐进式架构重构实施计划

> 本计划对应 `docs/superpowers/specs/2026-08-21-pages-api-architecture-refactor-design.md`。每个阶段必须保持可独立 review、验证和 revert；不得改变 Worker / Cloudflare 资源拓扑、API 合约、D1 schema、route snapshot schema 或 production/staging 隔离。

## Goal

在保留一个 `pages-api` Worker 和全部运行资源、接口及一致性语义的前提下，将当前扁平且由大型文件主导的实现迁移为 `transport -> application -> domain` 单向业务依赖、由 composition root 注入 infrastructure ports 的模块化单体；拆除跨 handler 业务复用、Store God object 和 `pages-auth -> pages-api/src` 源码依赖。

## 全程兼容清单

每阶段 review 都要确认以下项目没有变化：

- `apps/pages-api/wrangler.production.template.toml` 与 `wrangler.staging.template.toml` 中的 Worker、route、D1、KV、DO、VPC、service binding、Cron 及环境隔离；
- `apps/pages-api/src/schema.js`、D1 migrations、route snapshot/pointer schema；
- `apps/pages-api/src/openapi.js` 的 path、method、request/response、status、error code/action 和公开边界；
- deployment/rollback 的 idempotency、状态转换、Provider 调用、lease/CAS、route commit、补偿、recovery、trace、audit、webhook、cleanup 顺序；
- `src/index.js` 的默认 Worker 与 `RoutePointerDO` export；
- production 仅允许现有 GitHub Actions 手动部署。

## 阶段 0：基线与架构护栏

### Task 0.1：锁定依赖规则

**Files**

- Modify: `eslint.config.js`
- Add: `tests/pages-api-architecture.test.js`

**Steps**

- [x] 为 `domain/**` 禁止 application、transport、infrastructure、Cloudflare adapter imports。
- [x] 为 `application/**` 禁止 transport、infrastructure、HTTP handler 和完整 runtime `env` adapter imports。
- [x] 为 `infrastructure/**` 禁止 transport imports。
- [x] 为 `transport/public|console|internal/**` 禁止互相 import；允许 `transport/shared`。
- [x] architecture test 扫描 production ESM import specifier，覆盖 ESLint glob 容易漏掉的相对路径绕行。
- [x] 保留现有 app 跨源码 import 临时例外的可见失败清单，只允许已知的 `pages-auth` 两处，阶段 3 删除清单与例外。

**Verify**

```bash
node --test tests/pages-api-architecture.test.js
pnpm exec eslint eslint.config.js tests/pages-api-architecture.test.js apps/pages-api/src
```

### Task 0.2：锁定 Cloudflare binding/config inventory

**Files**

- Add: `apps/pages-api/src/config-inventory.test.js`
- Reference: `apps/pages-api/wrangler.production.template.toml`
- Reference: `apps/pages-api/wrangler.staging.template.toml`
- Reference: `.github/workflows/deploy-pages-v2*.yml`

**Steps**

- [x] 解析两套 Wrangler template，断言 binding 名称、DO migrations、Cron、routes 的结构对称且物理资源标识不相同。
- [x] 记录 production runtime 读取的 env key，并按 required / capability optional / binding 分类。
- [x] 断言本重构没有新增 binding、resource、Cron 或自动 production deploy trigger。

**Verify**

```bash
node --test apps/pages-api/src/config-inventory.test.js
```

### Task 0.3：修正文档漂移

**Files**

- Modify only the current truth-source documents identified by searches for `PAGES_AUTH`, legacy CLI JWT and obsolete zone secret names.

**Steps**

- [x] 区分历史计划记录与当前真相源，不改写 `docs/superpowers/**` 历史文档。
- [x] 当前架构/API/运维文档只保留真实 binding 与 secret 名称。

**Verify**

```bash
rg -n 'PAGES_AUTH|CLI.*JWT|CF_ZONE|ZONE_ID' README.md docs apps/pages-{api,auth,cli,skill} --glob '*.md' --glob '*.js' --glob '*.toml'
node --test tests/project-policy.test.js
```

## 阶段 1：Composition root、Transport Router 与 Capability Config

### Task 1.1：抽出顶层 transport router

**Files**

- Add: `apps/pages-api/src/transport/router.js`
- Add: `apps/pages-api/src/transport/router.test.js`
- Add: `apps/pages-api/src/transport/shared/request-context.js`
- Add: `apps/pages-api/src/transport/scheduled.js`
- Modify: `apps/pages-api/src/index.js`

**Steps**

- [x] 用现有 `index.test.js` route matrix 锁定 host/path/method、HTTPS、legacy token、health/docs/internal/console/public 分发顺序。
- [x] 将路由判定和 store-unavailable 映射机械移动到 router/request context。
- [x] 保留旧 handler 签名，由 adapter 调用；不移动领域逻辑。
- [x] `index.js` 只创建 runtime 并转发 `fetch`/`scheduled`，继续 export `RoutePointerDO`。

**Verify**

```bash
node --test apps/pages-api/src/index.test.js apps/pages-api/src/transport/router.test.js
```

### Task 1.2：拆 capability config readers

**Files**

- Add: `apps/pages-api/src/infrastructure/config/api-config.js`
- Add capability readers under: `apps/pages-api/src/infrastructure/config/`
- Add: `apps/pages-api/src/infrastructure/config/config.test.js`
- Keep temporarily: `apps/pages-api/src/config.js`

**Steps**

- [x] 按 API、WFP/provider、identity、runtime config、org directory、legacy、webhook/alert 拆最小只读值对象。
- [x] required base config 继续 fail closed 为 `API_ENV_INVALID`。
- [x] optional capability 仅在使用对应 use case 时产生原有错误，不扩大启动失败面。
- [x] 旧 `config.js` 暂作 re-export facade，最终阶段以 production caller 搜索为删除条件。

**Verify**

```bash
node --test apps/pages-api/src/config.test.js apps/pages-api/src/infrastructure/config/config.test.js apps/pages-api/src/index.test.js
```

## 阶段 2：Store Repositories、Transactions 与 D1 契约

### Task 2.1：建立 Store composition 与 row mapper 边界

**Files**

- Add: `apps/pages-api/src/infrastructure/store/create-store.js`
- Add: `apps/pages-api/src/infrastructure/store/row-mappers/*.js`
- Modify temporarily: `apps/pages-api/src/store.js`
- Add focused mapper/contract tests beside new modules.

**Steps**

- [x] 先搬无副作用 mapper/normalizer；每次只迁移一个领域。
- [x] `createPagesStore` 与 `D1PagesStore` export 暂时稳定，旧调用方无需同步切换。
- [x] 禁止在 mapper 内读取 env 或执行 SQL。

### Task 2.2：按领域拆 repository

**Files**

- Add under `apps/pages-api/src/infrastructure/store/repositories/`: identity、teams、sites、routes、deployments、runtime-config、access-keys、audit、webhooks、cleanup repositories.
- Add SQLite-backed contract tests beside each repository.

**Steps**

- [x] 每个 repository 只保留单领域查询/更新；参数显式包含 environment。
- [x] 先由旧 facade 委托新 repository，再迁移 production 调用方。
- [x] SQL 文本机械移动时不改变 predicates、ordering、null/default 或 row shape。

### Task 2.3：抽命名 transaction coordinator

**Files**

- Add under `apps/pages-api/src/infrastructure/store/transactions/`: create-site、v1-takeover、update-site-policy、activate-route、transfer-owner、runtime-config-mutation and deployment transactions.
- Extend: repository/transaction D1 contract tests.

**Steps**

- [x] 跨表原子行为继续在一个 `batch()` / CAS / lease coordinator 内执行。
- [x] 每个 coordinator 覆盖 late-statement failure rollback、CAS loss、environment mismatch 和 lease contention。
- [x] application 不得用多个 repository call 重拼原事务。

**Phase verify**

```bash
node --test apps/pages-api/src/store.test.js apps/pages-api/src/store-contract.test.js 'apps/pages-api/src/infrastructure/store/**/*.test.js'
```

## 阶段 3：`@xd/pages-metadata` 共享包

### Task 3.1：提取最小 identity metadata package

**Files**

- Add: `packages/pages-metadata/package.json`
- Add: `packages/pages-metadata/src/index.js`
- Add package modules/tests for user identity and department hydration.
- Modify: root workspace lockfile through `pnpm install --lockfile-only` only when required.

**Steps**

- [x] 仅提取 user identity、SSO merge/session version、department path/team identity/hydration 和必要的命名 transaction。
- [x] package 不依赖任何 app，不暴露完整 Pages Store，不包含 site/deployment/provider/HTTP。
- [x] pages-api identity adapter 组合该 package，保持现有 facade 行为。

### Task 3.2：迁移 pages-auth

**Files**

- Modify: `apps/pages-auth/package.json`
- Modify: `apps/pages-auth/src/oauth-endpoints.js`
- Modify affected tests.
- Modify: `eslint.config.js`
- Modify: `tests/pages-api-architecture.test.js`

**Steps**

- [x] `pages-auth` 只从 `@xd/pages-metadata` 显式 exports import。
- [x] 删除两处 `eslint-disable no-restricted-imports` 和已知例外清单。
- [x] 确认两个 Worker 仍使用各自现有 `PAGES_METADATA` / `XD_OFFICE_NET` bindings。

**Phase verify**

```bash
node --test 'packages/pages-metadata/src/**/*.test.js'
node --test 'apps/pages-auth/src/**/*.test.js' 'apps/pages-api/src/**/*identity*.test.js' 'apps/pages-api/src/**/*department*.test.js'
pnpm exec eslint apps/pages-auth/src packages/pages-metadata/src apps/pages-api/src
```

## 阶段 4：Sites 与 Runtime Config Application Services

### Task 4.1：建立 domain 规则和 application ports

**Files**

- Add under: `apps/pages-api/src/domain/sites/`, `domain/runtime-config/`, `application/ports/`.
- Add pure domain tests.

**Steps**

- [x] 迁移纯规则：actor capability、ownership、visibility/ACL、runtime value constraints；不携带 HTTP 文案。
- [x] ports 只覆盖被 use case 使用的方法，不按旧 Store 复制大接口。

### Task 4.2：逐动作收敛共享 use case

**Files**

- Add under: `application/sites/` and `application/runtime-config/`.
- Modify adapters in existing Public、Console、Admin handlers.

**Order**

- [x] create site；
- [x] delete site / enqueue deleted resources；
- [x] transfer owner；
- [x] update access policy + route snapshot compensation；
- [x] put/delete runtime var；
- [x] put/delete site secret。

每个动作先写 application orchestration tests，再将一个 transport 切到 use case，最后切其余入口并用 spy/fake 证明调用同一 factory 产物。Public/Console/Admin 差异只存在 actor/capability DTO 与响应 mapper。

**Phase verify**

```bash
node --test apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js 'apps/pages-api/src/application/{sites,runtime-config}/**/*.test.js'
node --test apps/pages-api/src/route-snapshot.test.js apps/pages-api/src/runtime-config-diagnostics.test.js apps/pages-api/src/site-kv-e2e.test.js
```

## 阶段 5：Deployments 与 Rollback 显式阶段

### Task 5.1：锁定现有 timeline 与 failure precedence

**Files**

- Extend focused characterization tests in `apps/pages-api/src/deployments.test.js` and contract tests.

**Steps**

- [x] 为 deploy/rollback 的 success 与每个 failure injection 点记录 Provider、D1、route pointer、trace、webhook、cleanup 的调用/落库顺序。
- [x] 覆盖 idempotency replay/conflict、lease/CAS loss、snapshot pointer failure、compensation failure 和 terminal persistence failure。

### Task 5.2：机械拆出 transport 与 application stages

**Files**

- Add: `transport/public/deployments-handler.js`
- Add under: `application/deployments/` for deploy-site、rollback-site、context、stages、recovery.
- Add domain validators under: `domain/deployments/`.
- Keep temporarily: `apps/pages-api/src/deployments.js` facade.

**Migration order**

- [x] multipart/intake 与 response mapping；
- [x] auth/site resolution/idempotency；
- [x] runtime config snapshot；
  - [x] 初始 vars/secrets resolution、quota/hash validation 与 Provider binding DTO；
  - [x] Provider 前后及 activation 前只读 snapshot fence；
  - [x] runtime vars commit 与失败补偿；
- [x] Provider upload/verify；
- [x] version create / route commit；
  - [x] immutable version record 构造、runtime snapshot hash 与 repository 写入；
  - [x] route lease / CAS、OfficeNet 与 activation；
- [x] route snapshot / terminal persistence；
- [x] cleanup/webhook；
- [x] compensation/recovery；
- [x] rollback 对应阶段。

每次只移动一个阶段；共享 context 不得包含 Request、Response 或完整 env；operation order 与错误 precedence 不得重排。

**Phase verify**

```bash
node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/deployment-trace.test.js apps/pages-api/src/execution-provider.test.js apps/pages-api/src/wfp-provider.test.js
node --test apps/pages-api/src/store-contract.test.js apps/pages-api/src/route-snapshot.test.js apps/pages-api/src/lifecycle-webhooks.test.js
```

## 阶段 6：Admin 与 Governance

### Task 6.1：拆 query projections 与 mutations

**Files**

- Add: `transport/console/admin-handler.js`
- Add under: `application/governance/` and `infrastructure/integrations/legacy-v1/`.
- Keep temporarily: `apps/pages-api/src/admin.js` facade.

**Order**

- [x] dashboard/deployment trace/audit projections；
- [x] public exposure mutation；
- [x] WFP orphan inventory/backfill；
- [ ] ordinary Worker inventory/retirement；
- [ ] v1 inventory/retirement；
- [ ] admin site/team/user mutations。

### Task 6.2：统一 cleanup use case

**Steps**

- [ ] scheduled handler 与 Admin run-due 调用同一个 cleanup application service。
- [ ] 保留 environment、reserved resource、active reference、destructive precondition 和审计顺序。
- [ ] `ctx.waitUntil` 通过窄 taskScheduler port 注入。

**Phase verify**

```bash
node --test apps/pages-api/src/admin.test.js apps/pages-api/src/admin-resource-governance.test.js apps/pages-api/src/platform-admins.test.js
node --test apps/pages-api/src/index.test.js apps/pages-api/src/legacy-v1/takeover.test.js
```

## 阶段 7：移除兼容层、同步真相源与完成审计

### Task 7.1：删除临时 facade 与 TestPagesStore 双实现

**Files**

- Remove or reduce then remove: root `deployments.js`, `store.js`, `sites.js`, `admin.js`, `config.js` compatibility exports.
- Replace: `apps/pages-api/src/test-store.js` with composed narrow fakes/route harness, or delete if no longer needed.

**Steps**

- [ ] production callers 只依赖新层级入口。
- [ ] repo-wide search 无跨 transport handler 业务 import、无 pages-auth 跨 app import、无完整 Store port。
- [ ] 手写 production 业务模块通常小于 800 行；超过 1000 行逐个给出单一职责证据或继续拆分。

### Task 7.2：同步 OpenAPI 与文档

**Files**

- Keep stable: `apps/pages-api/src/openapi.js`, `apps/pages-api/src/public-docs.js`.
- Modify current truth sources: `docs/api-boundary.md`, pages v2 architecture/operations docs and nearby README as needed.

**Steps**

- [ ] 如拆合约文件，稳定入口继续组合并导出相同行为。
- [ ] CLI/skill/help 无行为变化；只修正结构描述和已确认的旧配置漂移。
- [ ] `docs/superpowers/**` 继续作为历史记录，不充当运行态真相源。

### Task 7.3：最终 requirement-by-requirement audit

**Static evidence**

```bash
node --test tests/pages-api-architecture.test.js apps/pages-api/src/config-inventory.test.js
pnpm lint
git diff --check
```

**Focused/cross-app evidence**

```bash
node --test 'apps/pages-api/src/**/*.test.js'
node --test 'apps/pages-auth/src/**/*.test.js'
node --test 'apps/pages-console/src/**/*.test.js'
node --test 'apps/pages-router/src/**/*.test.js'
node --test 'packages/pages-metadata/src/**/*.test.js'
```

**Repository evidence**

```bash
pnpm test
```

如果 shell/Node glob 没有实际匹配测试文件，改用显式文件列表并记录实际 test count，禁止将 0 tests 视为通过。

**Manual diff audit**

- [ ] production/staging Wrangler template 拓扑与资源隔离没有变化；
- [ ] D1 migrations/schema 与 route snapshot schema 没有变化；
- [ ] OpenAPI snapshot 和 route/error characterization 无变化；
- [ ] workflow 没有新增 production 自动部署；
- [ ] `index.js` 为薄 composition root；
- [ ] 四个热点 God files 和完整 TestPagesStore 已退出；
- [ ] Public/Console/Admin 六类共享 mutation 都有统一 application service 证据；
- [ ] application 不读取 env、不处理 HTTP、不导入 infrastructure/transport；
- [ ] pages-auth 不导入 pages-api 源码，仓库不再有 production 跨 app source import exception。

## 提交与回滚策略

- 阶段 0/1/2/3/4/5/6/7 分别提交；大阶段可按一个领域或 deployment stage 继续拆小提交。
- 机械移动与调用方向改变分开提交；行为测试先于迁移提交。
- 每个提交只依赖此前已通过阶段，可直接 revert；不需要 D1 migration、资源回收或部署拓扑回滚。
- staging 只使用现有 workflow 验证；production 继续只允许人工触发。
