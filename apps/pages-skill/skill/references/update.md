# Skill 更新自检

每个会话首次使用 `xd-pages` skill 时，先做一次轻量版本自检，尽量更新到最新的 `xd-pages` skill，以获得最新内置 CLI 和 SDK。

## 自检流程

1. 检查 `xd-skill` 是否可用：

```bash
xd-skill --help
```

2. 如果 `xd-skill` 不可用，先安装：

```bash
npm i -g @xd-skill/cli
```

3. 查询当前 CLI 支持的 skill 更新能力：

```bash
xd-skill --help
```

4. 按 `xd-skill` help 输出检查并更新当前 `xd-pages` skill。不要在本文档复刻完整参数。

5. 自检完成后，再回到 `SKILL.md` 的起步流程，使用内置 CLI。

## 原则

- 自检只用于更新当前 `xd-pages` skill。
- 不要使用创建、上传或公开分发 skill 的命令。
- 以 `xd-skill` CLI help 为更新用法的权威来源。
- 更新失败时，说明失败原因；如果用户任务紧急，可以继续使用当前 skill 内置的 CLI 和 SDK。
- 不要在日志、文档或聊天内容里输出 token、cookie、access key 或其它 secret。
