# XD Pages CLI

CLI 是 XD Pages 发布和管理操作的权威入口。不要在 skill 文档里复刻完整命令参数；执行前先查询 CLI 自己的 help。

## 选择 CLI

始终使用 skill 内置 CLI：

```bash
node tools/pages-cli/main.js help
```

不要优先使用环境里的 `pages`，也不要引导用户把内置 CLI 全局安装。全局命令可能滞后于当前 skill 内置版本。

## 查询用法

根据用户意图先查询对应命令：

```bash
node tools/pages-cli/main.js help deploy
node tools/pages-cli/main.js help status
node tools/pages-cli/main.js help sites
node tools/pages-cli/main.js help rollback
node tools/pages-cli/main.js help access
node tools/pages-cli/main.js help open
node tools/pages-cli/main.js help login
```

## 执行流程

1. 先根据用户意图选择命令，例如发布、查看状态、回滚、打开 URL 或调整访问规则。
2. 运行该命令的 `help`，按 help 输出决定位置参数和选项。
3. 不主动切换目标环境；普通发布让 CLI 使用默认目标，内部测试环境按维护流程处理。
4. 需要机器可读结果时，使用 help 中支持的 JSON 输出参数。
5. 不方便交互登录的 agent 或 CI 场景，可以使用 help 中支持的发布 token 参数。
6. 遇到错误时，优先按 CLI 输出的错误码、提示和建议动作处理。

## 登录和凭证

- 优先使用 CLI help 中的登录命令完成交互登录。
- agent 或 CI 场景可以通过 CLI help 中支持的发布 token 参数传入凭证。
- 除非用户明确要求通过 CLI 登录命令保存凭证，否则不要把发布 token 写入本地状态。
- 不要打印、持久化、提交、截图或引用发布 token、CLI token、cookie、SSO code 或 secret。
- 不要把凭证发送到用户未确认的自定义 endpoint。

## 配置

`--config <file>` 是一次性输入，只能包含 CLI help 允许的非敏感发布参数。

不要创建隐藏项目绑定文件。不要在配置里保存凭证。
