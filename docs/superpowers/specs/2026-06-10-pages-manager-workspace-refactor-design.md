# pages-manager workspace 重构设计

## 背景

`pages-manager` 当前以仓库根目录和 `server/` 子目录混合组织代码。管理 API Worker 位于 `server/src/`，旧域名跳转 Worker 位于 `xdads-302/`，Wrangler 依赖和 lockfile 分散在根目录与 `server/`。同时，IP 白名单逻辑、JSON 响应 helper、Wrangler 配置生成逻辑存在重复。

本次设计目标是把仓库整理为可扩展的 pnpm workspace，并将确定的共享逻辑移入 `packages/`。这是一个本地完整重构 PR，允许目录迁移、包拆分和 CI/deploy workflow 配套调整一起完成，但实现过程中仍按阶段验证，避免把架构调整变成隐式行为变更。

## 目标

- 将 `server/` 迁移为 `apps/server/`。
- 将 `xdads-302/` 迁移为 `apps/xdads-302/`。
- 引入 pnpm workspace，使用根目录唯一 `pnpm-lock.yaml`。
- 新增 `packages/ip-guard/`，等价搬迁现有 IP allowlist 逻辑和子 Worker guard source。
- 新增 `packages/worker-kit/`，先只抽取低风险的 `jsonResponse()`。
- 新增 `scripts/gen-wrangler.sh`，用单环境顶层 `wrangler.toml` 生成模型替代 GitHub Actions heredoc。
- 保持根目录 `README.md`、`API.md`、`pages-deploy.skill.md` 作为公开契约文档真源。
- production 手动部署前增加 `pnpm lint` 和 `pnpm test`。

## 非目标

- 不引入 `wrangler --env`。
- 不改变 production 部署触发方式，production 仍只能 `workflow_dispatch`。
- 不改变 staging 部署触发方式，staging 仍支持 `workflow_dispatch` 和 push `staging`。
- 不统一 MIME 逻辑，不改变 static/spa 对外 `Content-Type` 行为。
- 不抽取 `Router` 到 `worker-kit`。
- 不改变 static/spa 与 worker preset 的 IP 限制接入方式。
- 不自动改写用户上传的 `_worker.js`。
- 不改变 `/readme.md` 的动态替换行为。本次只保证目录迁移后仍能按现状返回根 `README.md` 原文。
- 不新增真实 Cloudflare id、token、KV namespace id 或本地 `wrangler.toml` 到 Git。

## 目标目录结构

```text
pages-manager/
├── README.md
├── API.md
├── pages-deploy.skill.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── apps/
│   ├── server/
│   │   ├── package.json
│   │   ├── wrangler.template.toml
│   │   └── src/
│   │       ├── index.js
│   │       ├── handlers/
│   │       └── lib/
│   └── xdads-302/
│       ├── package.json
│       ├── wrangler.template.toml
│       └── index.js
├── packages/
│   ├── ip-guard/
│   │   ├── package.json
│   │   └── src/index.js
│   └── worker-kit/
│       ├── package.json
│       └── src/index.js
└── scripts/
    └── gen-wrangler.sh
```

## Workspace 设计

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*

catalog:
  wrangler: ^4.91.0
```

包命名：

```text
apps/server           -> @xd/server
apps/xdads-302        -> @xd/xdads-302
packages/ip-guard     -> @xd/ip-guard
packages/worker-kit   -> @xd/worker-kit
```

根目录继续作为统一开发入口：

```bash
pnpm install
pnpm lint
pnpm test
```

根 `package.json` 的测试脚本需要覆盖迁移后的 server 测试和 packages 测试：

```json
"test": "node --test \"apps/server/src/**/*.test.js\" \"packages/**/*.test.js\""
```

`server/pnpm-lock.yaml` 删除，根 `pnpm-lock.yaml` 成为唯一 lockfile。GitHub Actions 的 `cache-dependency-path` 改为根 `pnpm-lock.yaml`。

## 公开文档归属

根目录公开文档继续作为仓库级契约，不隶属于 `apps/server`：

- `README.md`：仓库说明，也是 `/readme.md` 的内容真源。
- `API.md`：HTTP API 人读文档。本次不被 Worker 直接服务。
- `pages-deploy.skill.md`：agent skill 真源，也是 `/skill.md` 的内容真源。

`apps/server` 只拥有 endpoint 的渲染和分发逻辑：

- `/openapi.json`：由 `openapi.js` 的 `BASE_SPEC` 生成，继续做 staging/production 动态替换，继续 `Cache-Control: no-store`。
- `/skill.md`：读取根目录 `pages-deploy.skill.md`，继续做 staging/production 动态替换，继续 `Cache-Control: no-store`。
- `/readme.md`：读取根目录 `README.md`，本次不新增动态替换，继续按现状返回原文和缓存头。

迁移后 `apps/server/src/index.js` 的文档 import 从：

```js
import README from '../../README.md';
import SKILL from '../../pages-deploy.skill.md';
```

改为：

```js
import README from '../../../README.md';
import SKILL from '../../../pages-deploy.skill.md';
```

`apps/server/wrangler.template.toml` 继续保留 Markdown Text rule，确保 `.md` import 能被 Wrangler 打包：

```toml
[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true
```

## `packages/ip-guard` 设计

本次 `ip-guard` 是等价搬迁，不改变子 Worker IP 限制模型。

现状保留：

- static/spa preset 仍由服务端生成子 Worker 代码。
- static/spa preset 仍在部署时把 allowlist baked 进 `worker.js`。
- static/spa preset 仍不绑定 `env.IP_ALLOWLIST`。
- static/spa preset 仍自动执行 `checkIP(request)`。
- worker preset 仍不改写用户上传的 `_worker.js`。
- worker preset 在 `ip_restrict=true` 时仍只绑定 `env.IP_ALLOWLIST`。
- worker preset 仍通过 `/openapi.json` 的 `x-libs.ip-guard.source` 提供 `checkIP(request, env)`。
- worker preset 仍返回 warning，提醒用户自己调用 `checkIP(request, env)`。

导出接口：

```js
export function parseAllowlist(value = '')
export function isAllowedIP(ip, allowlist = '')
export function buildBakedGuardSource(allowlist)
export const ENV_GUARD_SOURCE
```

用法：

```text
apps/server/src/index.js
- import { isAllowedIP } from '@xd/ip-guard'
- 管理 API 网关继续运行时读取 env.IP_ALLOWLIST

apps/server/src/lib/cf-api.js
- import { buildBakedGuardSource } from '@xd/ip-guard'
- static/spa generated Worker 继续使用 baked guard source

apps/server/src/handlers/openapi.js
- import { ENV_GUARD_SOURCE } from '@xd/ip-guard'
- x-libs.ip-guard.source 继续下发 env 版 checkIP(request, env)
```

测试覆盖：

- `parseAllowlist()` 支持逗号、空白、换行和混合分隔。
- `isAllowedIP()` 覆盖 IPv4 exact、CIDR、`/0`、`/32`、IPv6 exact、空 allowlist、缺失 IP、非法 IPv4、非法 CIDR。
- baked source 不读取 `env.IP_ALLOWLIST`。
- baked source 暴露 `checkIP(request)`，允许和拒绝 IP 的结果与现状一致。
- env source 读取 `env.IP_ALLOWLIST`。
- env source 暴露 `checkIP(request, env)`，允许和拒绝 IP 的结果与现状一致。
- worker preset metadata 仍在 `ip_restrict=true` 时绑定 `IP_ALLOWLIST`，并且用户 worker code 不被改写。

## `packages/worker-kit` 设计

本次 `worker-kit` 只抽取确定重复且低风险的 JSON Response helper。

导出接口：

```js
export function jsonResponse(data, status = 200, headers = {})
```

行为：

- 返回标准 `Response`。
- `body = JSON.stringify(data)`。
- `status` 默认 200。
- `Content-Type` 固定为 `application/json`。
- 允许附加额外 headers，但不能覆盖 `Content-Type`。

实现形态：

```js
export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });
}
```

使用范围：

- `apps/server/src/index.js`
- `apps/server/src/handlers/deploy.js`
- `apps/server/src/handlers/site.js`
- `apps/server/src/handlers/list.js`
- `apps/server/src/handlers/health.js`

不纳入本次：

- `Router`
- MIME 表
- Markdown response helper

测试覆盖：

- 默认 status 为 200。
- 自定义 status 生效。
- body JSON stringify 正确。
- `Content-Type` 固定为 `application/json`。
- 额外 header 可追加。
- 额外 header 不能覆盖 `Content-Type`。

## MIME 边界

`apps/server/src/lib/cf-api.js` 中当前有两套 MIME 逻辑：

- `MIME_WORKER_HELPER`：static/spa 子 Worker 运行时覆盖响应 `Content-Type`。
- `MIME_TYPES`：上传 manifest 时给 Workers Assets 设置 `content_type`。

两套表当前不完全一致。统一 MIME 会改变部分文件的对外 `Content-Type`，例如 `csv`、`mp3`、`wav`、`zip`、`eot` 等类型。因此本次不统一 MIME，不把 MIME 放入 `worker-kit`。

可以补 characterization tests 记录现状，但不在本次重构中改变 served response 的 MIME 行为。

## Wrangler 配置生成设计

本次不使用 `wrangler --env`。继续采用每个 GitHub Environment job 生成一份单环境顶层 `wrangler.toml` 的模型。

原因：

- 当前 staging/prod 隔离已经由独立 workflow job 和 GitHub Environment secrets/vars 承载。
- `wrangler --env` 会引入 vars、bindings、secrets non-inheritable 的额外复杂度。
- 本次目标是去掉 workflow heredoc 重复，不改变部署模型。

新增：

```text
apps/server/wrangler.template.toml
apps/xdads-302/wrangler.template.toml
scripts/gen-wrangler.sh
```

`scripts/gen-wrangler.sh` 调用方式：

```bash
scripts/gen-wrangler.sh apps/server production
scripts/gen-wrangler.sh apps/server staging
scripts/gen-wrangler.sh apps/xdads-302 production
```

`apps/server` 环境矩阵：

```text
server production:
- name: pages-manager
- PUBLIC_ENVIRONMENT: production
- PUBLIC_API_BASE: https://api.workers.xd.team
- PUBLIC_MANAGER_DEV_BASE: https://pages-manager.xd-cf-2022.workers.dev
- DOMAIN_BASE: workers.xd.team
- DOMAIN_LABEL: ""
- WORKER_PREFIX: pages-
- WORKERS_DEV_SUBDOMAIN: xd-cf-2022
- API_ROUTE: api.workers.xd.team

server staging:
- name: pages-manager-staging
- PUBLIC_ENVIRONMENT: staging
- PUBLIC_API_BASE: https://api-staging.workers.xd.team
- PUBLIC_MANAGER_DEV_BASE: https://pages-manager-staging.xd-cf-2022.workers.dev
- DOMAIN_BASE: workers.xd.team
- DOMAIN_LABEL: -staging
- WORKER_PREFIX: pages-staging-
- WORKERS_DEV_SUBDOMAIN: xd-cf-2022
- API_ROUTE: api-staging.workers.xd.team
```

脚本输入来自环境变量：

```text
CLOUDFLARE_ACCOUNT_ID
SITES_KV_NAMESPACE_ID
IP_ALLOWLIST
```

脚本职责：

- 校验 app 和 environment 参数合法。
- 校验必需环境变量存在。
- 根据 app + environment 选择固定配置矩阵。
- 校验 staging/prod 不串环境。
- 渲染 `<app>/wrangler.template.toml` 到 `<app>/wrangler.toml`。
- 不打印 secret 或真实 id。

安全校验：

- production worker name 禁止包含 `staging`。
- production route 禁止包含 `api-staging`。
- production `WORKER_PREFIX` 必须是 `pages-`。
- staging worker name 必须包含 `staging`。
- staging route 必须是 `api-staging.workers.xd.team`。
- staging `WORKER_PREFIX` 必须是 `pages-staging-`。
- `SITES_KV_NAMESPACE_ID` 不能为空。
- `IP_ALLOWLIST` 不能为空。

TOML 字符串渲染要限制或转义变量内容，避免引号、反斜杠、换行破坏生成结果。`IP_ALLOWLIST` 可采用字符集校验，限制为 IP、CIDR、逗号、空白和冒号等预期字符。

## Workflow 设计

`deploy.yml` production：

- 仍仅 `workflow_dispatch`。
- 仍使用 GitHub Environment `production`。
- 安装改为根目录 `pnpm install --frozen-lockfile`。
- 新增部署前 `pnpm lint` 和 `pnpm test`。
- 调用 `scripts/gen-wrangler.sh apps/server production`。
- 使用 `pnpm --dir apps/server exec wrangler deploy`。
- `wrangler secret put` 继续针对生成的单环境顶层 `apps/server/wrangler.toml` 目标 Worker 生效。

`deploy-staging.yml` staging：

- 保持 `workflow_dispatch` 和 push `staging`。
- 仍使用 GitHub Environment `staging`。
- 安装改为根目录 `pnpm install --frozen-lockfile`。
- 保持 `pnpm lint` 和 `pnpm test`。
- 调用 `scripts/gen-wrangler.sh apps/server staging`。
- 使用 `pnpm --dir apps/server exec wrangler deploy`。
- `wrangler secret put` 继续针对生成的单环境顶层 `apps/server/wrangler.toml` 目标 Worker 生效。

CI：

- 保持 pull request 和 push `master` 触发。
- 安装改为根目录 `pnpm install --frozen-lockfile`。
- 继续运行 `pnpm lint` 和 `pnpm test`。

`xdads-302`：

- 本次迁移目录和 template。
- 不强行新增部署 workflow，除非现有发布流程需要补齐。

## 文档更新

必须同步：

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`

更新内容：

- `server/src/` 改为 `apps/server/src/`。
- `server/src/handlers/` 改为 `apps/server/src/handlers/`。
- `server/src/lib/` 改为 `apps/server/src/lib/`。
- `server/wrangler.toml` 改为 `apps/server/wrangler.toml`。
- `xdads-302/wrangler.toml` 改为 `apps/xdads-302/wrangler.toml`。
- 文件结构改为 `apps/` 与 `packages/`。
- 本地开发命令改为 `pnpm --dir apps/server dev` 或 `cd apps/server && pnpm dev`。
- 部署说明改为由 `scripts/gen-wrangler.sh` 生成 `wrangler.toml`。

`AGENTS.md` 与 `CLAUDE.md` 必须保持一致。本次已删除两份文件中“一个 PR 只做一个目的。超过约 500 行 diff 时，Description 顶部说明为什么不能拆。”这条规则。

## 实施顺序

虽然最终是一个本地重构 PR，实施仍按阶段提交验证：

1. Workspace 骨架
   - 新增 `pnpm-workspace.yaml`。
   - `git mv server apps/server`。
   - `git mv xdads-302 apps/xdads-302`。
   - 新增 app package metadata。
   - 调整根 scripts、`.gitignore`、workflow 路径。

2. `worker-kit`
   - 新增 `packages/worker-kit`。
   - 实现 `jsonResponse()`。
   - 替换 server 内重复 JSON helper。
   - 补 worker-kit 测试。

3. `ip-guard`
   - 新增 `packages/ip-guard`。
   - 等价搬迁 `parseAllowlist()` 和 `isAllowedIP()`。
   - 等价搬迁 baked guard source builder。
   - 等价搬迁 env guard source。
   - 替换 server index、cf-api、openapi 中的对应逻辑。
   - 补算法和 source 生成测试。

4. Wrangler generator
   - 新增 app-level `wrangler.template.toml`。
   - 新增 `scripts/gen-wrangler.sh`。
   - 修改 deploy workflow 使用 generator。
   - 删除 workflow heredoc。

5. 文档同步
   - 更新 `README.md`。
   - 更新 `AGENTS.md` 和 `CLAUDE.md` 路径。
   - 核对 `API.md`，如行为未变则不需要改接口内容。

6. 验证
   - 运行 install、lint、test。
   - 生成 staging/prod `wrangler.toml` 并 dry-run。
   - 确认生成的 `wrangler.toml` 未被 Git 跟踪。

## 验证命令

基础验证：

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
```

Generator 与 Wrangler dry-run：

```bash
CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITES_KV_NAMESPACE_ID=dummy-kv \
IP_ALLOWLIST=127.0.0.1,::1 \
scripts/gen-wrangler.sh apps/server staging

pnpm --dir apps/server exec wrangler deploy --dry-run
```

```bash
CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITES_KV_NAMESPACE_ID=dummy-kv \
IP_ALLOWLIST=127.0.0.1,::1 \
scripts/gen-wrangler.sh apps/server production

pnpm --dir apps/server exec wrangler deploy --dry-run
```

注意：

- dry-run 只验证打包和配置结构。
- dry-run 不验证真实 Cloudflare secrets 是否存在。
- dummy 生成的 `apps/server/wrangler.toml` 不得提交。

## 回归重点

公开端点：

- `/openapi.json` staging 不返回 production API 地址。
- `/skill.md` staging 不返回 production API 地址。
- `/readme.md` 在路径迁移后仍能返回根 `README.md` 原文。

Token 隔离：

- `/list` 无 token 返回 400。
- `/list` 只返回当前 token 名下站点。
- `/list` 不返回 token 字段。

IP 限制：

- 管理 API `isAllowedIP()` 行为保持。
- static/spa baked guard 不依赖 `env.IP_ALLOWLIST`。
- worker preset metadata 仍绑定 `env.IP_ALLOWLIST`。
- worker preset 用户代码不被改写。

部署隔离：

- staging generated toml 使用 `pages-manager-staging`、`api-staging.workers.xd.team`、`pages-staging-`。
- production generated toml 使用 `pages-manager`、`api.workers.xd.team`、`pages-`。
- production workflow 仍只有 `workflow_dispatch`。
- production 手动部署前会运行 `pnpm lint` 和 `pnpm test`。

## 风险与回滚

主要风险：

- 大规模路径迁移导致 import、test glob、workflow path 漏改。
- workspace lockfile 更新导致 CI install 行为变化。
- `ip-guard` 等价搬迁中 baked/env guard source 语义漂移。
- generator 模板渲染错误导致 staging/prod 串环境。
- Wrangler 打包跨目录 Markdown import 行为与预期不一致。

缓解：

- 使用 `git mv` 保留历史。
- 每个阶段后运行 focused tests。
- 对 generator 输出做字符串断言或 shell 自检。
- 对 `ip-guard` 增加 baked/env 两路测试。
- 使用 staging/prod dummy dry-run 验证 Wrangler 打包。

回滚：

- 如 workspace 迁移失败，可回滚目录迁移和 workspace metadata。
- 如 `ip-guard` 出现行为差异，可临时恢复 server 内原有实现，再保留 workspace 结构。
- 如 generator 风险过高，可保留 app template，但 workflow 暂时继续 heredoc，待 generator 单独修正。
