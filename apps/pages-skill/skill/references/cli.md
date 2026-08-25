# XD Cell CLI

CLI 是 XD Cell 发布和管理操作的权威入口。不要在 skill 文档里复刻完整命令参数；执行前先查询 CLI 自己的 help。

## 选择 CLI

始终使用 skill 内置 CLI：

```bash
node tools/xd-cell-cli/main.js help
```

不要优先使用环境里的 `xd-cell`，也不要引导用户把内置 CLI 全局安装。全局命令可能滞后于当前 skill 内置版本。

## 查询用法

根据用户意图先查询对应命令：

```bash
node tools/xd-cell-cli/main.js help deploy
node tools/xd-cell-cli/main.js help status
node tools/xd-cell-cli/main.js help sites
node tools/xd-cell-cli/main.js help teams
node tools/xd-cell-cli/main.js help secrets
node tools/xd-cell-cli/main.js help access
node tools/xd-cell-cli/main.js help open
node tools/xd-cell-cli/main.js help login
```

## 执行流程

1. 先根据用户意图选择命令，例如发布、查看状态、打开 URL、管理站点级 secret 或调整访问规则。
2. 运行该命令的 `help`，按 help 输出决定位置参数和选项。
3. 不主动切换目标环境；普通发布让 CLI 使用默认目标，内部测试环境按维护流程处理。
4. 需要机器可读结果时，使用 help 中支持的 JSON 输出参数。
5. 不方便交互登录的 agent 或 CI 场景，可以使用 `XD_CELL_API_TOKEN` 或 help 中支持的一次性 token 参数。
6. 遇到错误时，优先按 CLI 输出的错误码、提示和建议动作处理。

## 登录和凭证

- 优先使用 CLI help 中的登录命令完成交互登录。
- agent 或 CI 场景可以通过 `XD_CELL_API_TOKEN` 或 CLI help 中支持的一次性 token 参数传入凭证。
- 除非用户明确要求通过 CLI 登录命令保存凭证，否则不要把 API token 写入本地状态。
- 不要打印、持久化、提交、截图或引用 API token、CLI access key、CLI token（legacy）、cookie、SSO code 或 secret。
- 不要把凭证发送到用户未确认的自定义 endpoint。

## 站点归属与凭证边界

CLI 当前不提供独立的归属转移命令。交互用户应使用 Console；只有受控集成才使用 Public transfer API，并由服务端执行以下授权边界：

- 用户登录凭证、Cindy Connection JWT 和 Personal Access Token（PAT）只允许当前个人 Owner 或源团队 `admin` 发起转移。转给个人时只能转给已认证 actor 自己；转给团队时，actor 必须是目标团队的 `publisher` 或 `admin`。
- Team Access Token（TAT）不能通过 Public transfer API 改变 Owner，也不能通过向相同 Owner 提交请求来绕过限制。
- `xd-cell deploy --team <teamId>` 创建团队站点时，目标团队的 `publisher/admin` 可以发布。既有站点随发布隐式转移时，个人源站点要求当前 Owner，团队源站点要求源团队 `admin`；目标团队仍要求 `publisher/admin`。
- Team Access Token（TAT）只能继续发布其自身团队站点，不能改变 Owner；不得用它把个人站点或其他团队站点转入该团队，也不得转到其他团队。

不要为了归属转移猜测 API 请求、认证 header 或内部路由；普通用户与 agent 按 Console 和 CLI 已公开能力操作。

## 配置

`--config <file>` 是一次性输入，只能包含 CLI help 允许的非敏感发布模板字段。默认模板名是 `xd-cell.config.json`。

配置中的 `name` 始终表示站点 URL slug，不是展示名称。站点 URL 在 Console 或认证 API 中改名后，旧 slug 不再定位原站点；安全期内会因 hostname claim 冲突而拒绝发布，安全期结束后可被其它站点使用。CLI 不会自动修改配置文件；继续发布前应先告知用户并同步本地 `name`。CLI 当前不提供名称、URL 或缩略图编辑命令。

`vars` 只能保存非敏感 Worker runtime 配置。它是站点级当前 runtime config，由 Worker deploy 同步；配置省略 `vars` 时沿用站点当前值，显式 `{}` 会在下一次 Worker deploy 清空。secret value 使用 `xd-cell secrets put/delete`，不要写入配置文件，也不要枚举远端 runtime 配置。

不要创建隐藏项目绑定文件。不要在配置里保存凭证。

runtime bindings 只注入 Worker 发布；单个 var / secret value 当前限制为 8 KiB，单次 Worker 发布最多 64 个 runtime bindings。站点发布权限是高信任权限：能发布 Worker 代码，也能设置并使用该站点 secrets。
