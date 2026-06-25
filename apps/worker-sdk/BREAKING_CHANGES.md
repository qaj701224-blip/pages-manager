# 破坏性变更

## 状态

首次发布前存在草案级破坏性变更；对已发布 npm 用户无破坏性变更。

## 适用版本

- `@xd-cell/worker-sdk`：0.1.1

## 影响对象

- 业务自定义 Worker；
- 使用 Worker SDK 的 AI agent；
- 维护 Worker SDK 发布流程的开发者。

## 旧用法

旧草案使用 `@xd-pages/worker-sdk` 包名，并以品牌化函数和 scope-specific KV 入口作为主要心智。

## 新用法

新用法安装 `@xd-cell/worker-sdk`，公开 API 去品牌化，并把默认 KV namespace 对齐 Cloudflare KV binding 心智：

```ts
import { createRuntime, readContext } from '@xd-cell/worker-sdk';

const runtime = createRuntime({ request, env });
const context = readContext(request);

await runtime.kv.put('app/config', { enabled: true }, { type: 'json' });
const config = await runtime.kv.get('app/config', { type: 'json' });
const message = await runtime.kv.get('app/message');
```

## Agent 处理动作

Agent 应把 `@xd-cell/worker-sdk` 视为用户项目的显式运行时依赖。接入业务自定义 Worker 前，先检查并安装该包，再读取包内 `docs/llms/*`、README、类型声明和 `BREAKING_CHANGES.md`。

如果当前 registry 中尚不可安装该包，不要从 `xd-cell` skill 构建产物中寻找 SDK 副本，也不要复制 monorepo 内部源码到业务项目伪装成发布包；应向用户说明依赖不可用并暂停接入，或在本仓库内继续开发 Worker SDK。

## 兼容说明

- 当前目标导入路径为 `@xd-cell/worker-sdk`。
- 推荐 runtime 入口为 `createRuntime`。
- 推荐 context 入口为 `readContext`。
- 推荐 KV 入口为 `runtime.kv.get()`、`runtime.kv.put()` 和 `runtime.kv.delete()`。
- `runtime.kv.get()` 和 `runtime.kv.put()` 默认使用 text，JSON 必须显式传入 `{ type: 'json' }`。
- 旧草案中的品牌化函数、`data` 入口、scope-specific KV 入口和 `set()` alias 不进入首发公共面。
- D1/R2 只是规划资源，当前没有公开 API；agent 不应生成 `runtime.d1` 或 `runtime.r2` 调用。
- `xd-cell` skill 只维护与 Worker SDK 的版本兼容说明，不复制 Worker SDK 领域产物。
- 公开包名只认 `@xd-cell/worker-sdk`。
- `@xd/pages-sdk/*`、`@xd-pages/sdk/*`、`@xd-pages/worker-sdk` 和 `@xd-pages/worker-sdk/worker` 只作为历史草案或旧文档路径识别；不要新增使用，也不要为这些路径补兼容。

## 验证方式

迁移后至少运行：

```bash
pnpm --dir apps/worker-sdk run pack:check
```
