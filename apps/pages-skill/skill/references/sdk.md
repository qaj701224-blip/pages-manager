# XD Cell Worker SDK

Worker SDK 是业务自定义 Worker 的运行时依赖，包名为 `@xd-cell/worker-sdk`。Skill 不复制 Worker SDK 领域产物，不内置 `tools/worker-sdk`，也不手写维护 SDK API 细节。

## 关系边界

- `xd-cell` skill：包名 `@xd-cell/skill`，提供 agent 操作流程、内置 `@xd-cell/cli`、版本兼容和安全边界说明。
- `@xd-cell/worker-sdk`：提供业务 Worker 可 import 的 runtime helper、README、类型声明、`docs/llms/*` 和 `BREAKING_CHANGES.md`。
- 外部 Worker SDK：由用户或 agent 按文档安装 `@xd-cell/worker-sdk`，skill 只读取其包内文档，不复制 SDK API 细节。

Worker SDK 的 AI 文档随 `@xd-cell/worker-sdk` 包发布。Agent 需要了解 SDK API 时，优先读取已安装 npm 包内的文档，而不是从 skill 目录读取副本。

## 何时使用 Worker SDK

只有业务项目包含或需要编写自定义 Worker，并且该 Worker 运行时需要访问 XD Cell 托管资源时，才接入 Worker SDK：

- 需要以接近 Cloudflare Worker KV 的心智读写平台托管 KV / runtime data：`runtime.kv.get()`、`runtime.kv.put()`、`runtime.kv.delete()`。
- 需要读取平台 router 注入的上下文：`readContext(request)`，例如站点、版本、用户、trace 等业务信息。
- 需要把旧草案 SDK/import 迁移到公开包 `@xd-cell/worker-sdk`。
- 需要避免业务代码直接感知 gateway、capability、内部 header 或底层 binding 名称。

## 何时不要使用 Worker SDK

以下任务不要因为普通发布任务安装 Worker SDK，也不要要求用户项目新增 SDK 依赖：

- 只是发布静态站点、SPA、查看状态、回滚、打开站点或配置访问控制。
- 项目没有自定义 Worker 入口。
- 浏览器端代码想直接访问平台 KV；Worker SDK 只用于 Worker 运行时。
- 需要登录、发布、OpenAPI client、token 管理、CLI 操作，或当前尚未公开的 D1/R2 能力。
- 只是想了解 XD Cell CLI 用法；这类任务读取 `references/cli.md` 和 CLI help。

## 依赖模式

- Worker SDK 是业务项目运行时依赖，必须由用户项目显式声明；需要在项目代码中 import Worker SDK 时，按项目包管理器添加依赖，例如 `pnpm add @xd-cell/worker-sdk`。
- Skill 的 `manifest.json` 只记录推荐包名、版本、安装命令和包内文档路径；它不是全局依赖管理器，也不维护本地 SDK cache。
- Agent 需要了解 SDK API 时，读取用户项目依赖中的 `node_modules/@xd-cell/worker-sdk/docs/llms/*`、README、类型声明和 `BREAKING_CHANGES.md`。
- 不要只因为 agent 想查文档，就新增用户项目依赖；只有确实要编写、迁移或修改自定义 Worker runtime 代码时才安装。
- 不要因为普通发布任务安装 Worker SDK；只有命中“何时使用 Worker SDK”才进入后续流程。

## Agent 文档接入流程

1. 读取 skill release manifest，确认推荐的 Worker SDK 包名和版本：

```bash
node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
console.log(JSON.stringify(manifest.dependencies.workerSdk, null, 2));
NODE
```

2. 如果本次没有命中“何时使用 Worker SDK”，停止在这里；不要因为普通发布任务安装 Worker SDK。

3. 检查用户项目是否已经安装匹配的 `@xd-cell/worker-sdk`。下面示例中 `SKILL_ROOT` 是当前 skill 构建产物目录，`PROJECT_ROOT` 是用户项目根目录：

```bash
SKILL_ROOT="${SKILL_ROOT:-.}"
PROJECT_ROOT="${PROJECT_ROOT:-$PWD}"
node - "$SKILL_ROOT" "$PROJECT_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [skillRoot, projectRoot] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, 'manifest.json'), 'utf8'));
const sdk = manifest.dependencies.workerSdk;
const sdkRoot = path.join(projectRoot, sdk.packagePath);
const packageJsonPath = path.join(sdkRoot, 'package.json');

if (!fs.existsSync(packageJsonPath)) {
  console.error(`缺少 ${sdk.packageName}，请运行：${sdk.installCommand}`);
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (packageJson.name !== sdk.packageName) {
  console.error(`Worker SDK 包名不匹配：${packageJson.name}`);
  process.exit(1);
}
if (packageJson.version !== sdk.recommendedVersion) {
  console.error(`Worker SDK 版本为 ${packageJson.version}，推荐版本为 ${sdk.recommendedVersion}。请运行：${sdk.installCommand}`);
  process.exit(1);
}

console.log(sdkRoot);
NODE
```

4. 如果缺少依赖或版本不匹配，按 `manifest.json` 的 `installCommand` 在用户项目中安装；当前首发推荐命令类似：

```bash
pnpm add @xd-cell/worker-sdk
```

5. 从用户项目依赖读取包内高信号文档：

```bash
SDK_ROOT="$PROJECT_ROOT/node_modules/@xd-cell/worker-sdk"
sed -n '1,220p' "$SDK_ROOT/docs/llms/worker-sdk.md"
sed -n '1,220p' "$SDK_ROOT/docs/llms/worker-sdk-api.md"
sed -n '1,160p' "$SDK_ROOT/BREAKING_CHANGES.md"
```

6. 需要确认实际导出时，读取安装包的 `package.json`：

```bash
SDK_ROOT="$PROJECT_ROOT/node_modules/@xd-cell/worker-sdk"
node -e "const pkg=require('$SDK_ROOT/package.json'); console.log(JSON.stringify(pkg.exports, null, 2))"
```

7. 按包内 `docs/llms/worker-sdk.md` 和 `docs/llms/worker-sdk-api.md` 选择公开导入方式；不要在 skill reference 中固化 SDK 函数签名。

8. 如果用户项目不是 pnpm 项目，沿用它已有的包管理器；npm 项目的等价命令是：

```bash
npm install @xd-cell/worker-sdk
```

## 未发布或无法安装时

如果 `@xd-cell/worker-sdk` 尚未发布、registry 不可用，或当前环境无法安装依赖：

- 不要从 skill 构建产物中寻找 `tools/worker-sdk`。
- 不要复制 monorepo 内部源码到用户项目伪装成包依赖。
- 向用户说明当前 Worker SDK 依赖不可用，并根据任务性质选择暂停、使用项目已有实现，或在仓库内继续修改 `apps/worker-sdk` 源码。
- 如果是在本 monorepo 内开发 Worker SDK，真相源是 `apps/worker-sdk/README.md`、`apps/worker-sdk/package.json`、`apps/worker-sdk/docs/llms/*`、类型声明和测试。

## 边界原则

把 Worker SDK 当作业务自定义 Worker 的运行时薄封装，不把它当作发布、登录或平台管理 SDK。判断不清时，按以下边界处理：

- API 边界：Worker SDK 不是管理面 SDK，不负责登录、发布、站点管理、OpenAPI client 或 token 管理；这些能力继续使用 `@xd-cell/cli` 和平台 API。
- 公开导出边界：只使用公开 exports、包内 `docs/llms/*`、README 和类型声明；不要 import internal 文件、猜函数名或猜参数。
- 包名边界：公开包名只认 `@xd-cell/worker-sdk`。遇到 `@xd-pages/sdk/*`、`@xd/pages-sdk/*`、`@xd-pages/worker-sdk` 或 `@xd-pages/worker-sdk/worker`，一律视为历史草案或旧文档路径；不要新增使用、不要为这些路径补兼容，迁移时按当前包内 `docs/llms/*`、README、类型声明和 `exports` 改到公开导入。
- 资源边界：底层资源能力通过平台注入，业务 Worker 只通过 Worker SDK 暴露的 runtime API 操作；不要绕过 Worker SDK 直连 gateway、capability endpoint 或内部 binding。
- 凭证边界：Runtime 服务绑定凭证必须放在 Worker bindings 和 secrets 中，不要写入源码文件、配置、日志或文档。
- 上下文边界：自定义 Worker 代码不能信任浏览器传入的平台相关 header；需要平台上下文时按 Worker SDK 文档读取平台 router 注入的上下文。
- 授权边界：`readContext` 只能作为业务上下文读取入口，不能作为 data 授权凭证；不要把 `readContext` 的用户信息当作授权结论。
- 运行时边界：Worker SDK 只用于 Worker 运行时；浏览器端、CLI 脚本或 Node 管理脚本不要 import 它来访问平台资源。
- 能力边界：只使用当前 Worker SDK 文档明确公开的 KV/runtime context 能力；D1/R2 等未公开能力不要自行设计 import 或 fallback。
