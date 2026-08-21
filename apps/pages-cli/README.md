# @xd-cell/cli

`@xd-cell/cli` 是 XD Cell 的命令行入口，用于登录、发布和管理站点。用户、CI 和 AI agent 都应通过 CLI 操作，不要直接拼接 pages-api HTTP 请求。

## 安装

```bash
npm install -g @xd-cell/cli
```

要求 Node.js `>=22.12.0`。

安装后运行：

```bash
xd-cell help
```

## 常用命令

```bash
# 登录与状态
xd-cell login
xd-cell logout
xd-cell whoami --json
xd-cell status demo --json
xd-cell --version

# 本地识别与发布
xd-cell detect ./dist --json
xd-cell deploy ./dist demo --visibility org

# 站点
xd-cell sites list --json
xd-cell sites info demo --json
xd-cell sites delete demo --yes --json

# 团队
xd-cell teams --json

# 站点级 Worker secret
xd-cell secrets put demo API_TOKEN
echo "$API_TOKEN" | xd-cell secrets put demo API_TOKEN --stdin
xd-cell secrets delete demo API_TOKEN

# 访问范围与 ACL
xd-cell access get demo --json
xd-cell access set demo --visibility acl --email user@xd.com
xd-cell access grant demo --email another@xd.com
xd-cell access revoke demo --email another@xd.com

# 站点 URL
xd-cell open demo --print
```

需要完整参数、选项和错误码时，使用对应命令的 help：

```bash
xd-cell help deploy
xd-cell help sites
xd-cell help access
```

## 非交互使用

支持结构化 JSON 的命令使用 `--json`。CI 或 agent 可以通过一次性环境变量传入 API token：

```bash
XD_CELL_API_TOKEN=<token> xd-cell sites list --json
```

也可以使用 `--token <token>` 只为当前命令提供 token。不要把 token 写入项目文件、日志或命令输出；站点级 Worker secret 使用 `xd-cell secrets put/delete` 管理。

部署响应带有关联号时，普通输出会显示 `追踪：dtr_...`，`--json` 成功结果和错误对象会包含 `deploymentTraceId`。排查部署失败时可把这个关联号提供给平台管理员；它不包含凭证或站点内容。

`sites delete` 在非交互或 JSON 模式下必须显式传入 `--yes`。删除行为和错误码以 CLI 输出及当前平台契约为准。

## 配置

`xd-cell deploy` 可以读取项目中的 `xd-cell.config.json`，仅保存非敏感发布配置，例如站点名、Worker 入口、assets、vars 和 visibility。凭证和 secret 不应写入配置文件。

## 开发

```bash
pnpm --dir apps/pages-cli test
pnpm --dir apps/pages-cli build
```

这个 README 会随构建产物一起进入 npm 包；CLI help 是命令参数和 JSON 输出的权威来源。
