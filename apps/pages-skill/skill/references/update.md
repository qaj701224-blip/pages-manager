# Skill 更新自检

每个会话首次使用 `xd-cell` skill 时，先做一次轻量版本自检，尽量更新到最新的 `@xd-cell/skill`，以获得最新内置 CLI 和 Worker SDK 兼容说明。

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

4. 按 `xd-skill` help 输出检查并更新当前 `xd-cell` skill / `@xd-cell/skill` 包。不要在本文档复刻完整参数。

5. 自检完成后，再回到 `SKILL.md` 的起步流程，使用内置 CLI。

6. 读取 `manifest.json`，确认当前 skill 的内置依赖和推荐外部依赖：

```bash
node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
console.log(JSON.stringify({
  skill: manifest.skill,
  cli: manifest.dependencies.cli,
  workerSdk: manifest.dependencies.workerSdk,
}, null, 2));
NODE
```

7. 检查内置 CLI 与 `manifest.json` 一致：

```bash
node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const cli = manifest.dependencies.cli;
const packageJson = JSON.parse(fs.readFileSync(cli.packageJsonPath, 'utf8'));

if (packageJson.name !== cli.packageName || packageJson.version !== cli.version) {
  console.error(`内置 CLI 与 manifest 不一致：${packageJson.name}@${packageJson.version}`);
  process.exit(1);
}

console.log(`${cli.packageName}@${cli.version}`);
NODE
```

8. 如果本次任务需要接入 Worker SDK，再按 `references/sdk.md` 检查用户项目依赖中的 `@xd-cell/worker-sdk`。Worker SDK 是外部项目依赖，缺失或版本不匹配不代表 skill 自身不可用，但接入 Worker runtime helper 前必须处理。

## 原则

- 自检只用于更新当前 `xd-cell` skill。
- 不要使用创建、上传或公开分发 skill 的命令。
- 以 `xd-skill` CLI help 为更新用法的权威来源。
- `manifest.json` 是 skill 内部依赖版本关系的权威来源。
- 更新失败时，说明失败原因；如果用户任务紧急，可以继续使用当前 skill 内置的 CLI；Worker SDK 仍以用户项目安装的 `@xd-cell/worker-sdk` 为准。
- 不要在日志、文档或聊天内容里输出 token、cookie、access key 或其它 secret。
