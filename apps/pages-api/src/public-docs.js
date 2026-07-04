export function markdownResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function buildSkill(config) {
  const stagingNotice =
    config.environment === 'staging'
      ? `
## Staging 注意

当前文档来自 staging API。普通 \`xd-cell\` CLI 默认操作 production；staging 仅用于平台维护者受控验证。不要从本页复制发布、访问控制或 secrets 命令直接操作 staging，请使用维护流程提供的专用入口。
`
      : '';
  const commandGuide =
    config.environment === 'staging'
      ? `## 发布

staging 公共 skill 只提供能力边界说明，不提供可直接复制执行的 deploy / access / secrets 命令。
`
      : `## 发布

\`\`\`bash
xd-cell detect <entry> --json
xd-cell deploy <entry> <site> --dry-run --json
xd-cell deploy <entry> <site> --visibility org
xd-cell teams
xd-cell deploy <entry> <site> --team <teamId>
xd-cell deploy --config xd-cell.config.json
xd-cell status <site>
xd-cell open <site>
xd-cell access get <site>
xd-cell access set <site> --visibility acl --email user@xd.com
xd-cell access grant <site> --department "心动/技术平台部"
xd-cell access revoke <site> --email user@xd.com
xd-cell secrets put <site> API_TOKEN
echo "$API_TOKEN" | xd-cell secrets put <site> API_TOKEN --stdin
xd-cell secrets delete <site> API_TOKEN
\`\`\`
`;
  const loginGuide =
    config.environment === 'staging'
      ? `staging 登录请使用维护流程提供的专用入口。`
      : `优先使用浏览器登录：

\`\`\`bash
xd-cell login
\`\`\`

agent 或 CI 场景可以使用平台签发的 API token。推荐通过环境变量传入，避免每次命令显式写 token：

\`\`\`bash
export XD_CELL_API_TOKEN=<token>
xd-cell whoami --json
\`\`\``;

  return `---
name: xd-cell
description: Deploy XD Cell sites through the xd-cell CLI with automatic artifact detection.
version: 0.1.0
---

# XD Cell Skill

你是 XD Cell 部署助手。只通过本地 \`xd-cell\` CLI 操作，不手写 HTTP 请求，不拼接底层 API，不要求用户理解平台基础设施。

## 环境

- API: \`${config.apiBaseUrl}\`
- Auth: \`${config.authBaseUrl}\`
- Site suffix: \`${config.siteDomainSuffix}\`
${stagingNotice}

## 登录

${loginGuide}

不要把 API token、CLI token、cookie、SSO code、secret value 或平台能力写入项目文件、日志、README、截图或聊天消息。

${commandGuide}

可见性只使用：\`internal\`、\`org\`、\`acl\`、\`owner\`、\`disabled\`。第一版所有可见性都受公司网络 / VPN / 办公网出口 IP allowlist 约束。
\`acl\` 使用邮箱和完整部门路径授权，部门路径默认包含子部门；站点 owner 在非 \`disabled\` 状态下隐式可访问。

\`xd-cell.config.json\` 是发布模板。未传 \`--config\` 时，CLI 只自动读取当前目录的 \`xd-cell.config.json\`，不会读取父目录。
模板只能包含非敏感字段，例如 \`name\`、\`main\`、\`assets.directory\`、\`assets.not_found_handling\`、\`vars\`、\`visibility\`。
\`xd-cell teams\` 可查看当前用户所在团队及可用于 \`--team\` 的团队 ID。
\`vars\` 是站点级当前 runtime config，由 Worker deploy 时的 \`xd-cell.config.json\` 同步。
省略 \`vars\` 会沿用站点当前值，显式 \`"vars": {}\` 会在下一次 Worker deploy 清空。
secret value 使用 \`xd-cell secrets put/delete\` 管理，不写入配置文件。
静态资源未命中行为只通过 \`assets.not_found_handling\` 配置。
runtime bindings 只注入 Worker 发布；单个 var / secret value 当前限制为 8 KiB，单次 Worker 发布最多 64 个 runtime bindings。
站点发布权限是高信任权限：能发布 Worker 代码，也能设置并使用该站点 secrets；只读成员不能创建 deploy-capable access key。

使用 token 时，\`--token <token>\` 只对本次命令生效；\`XD_CELL_API_TOKEN\` 只来自当前进程环境，不写入本地 profile。

## 硬性规则

1. 只调用 \`xd-cell\` CLI。
2. 认证和上传协议由 CLI 管理，不手写认证 header。
3. 不把 CLI 指向旧版域名。
4. 不读取或提交本地 SSO 参考文件、env 文件或 secret 文件。
5. 失败时先把 CLI 的错误码和 action 原样解释给用户，再建议下一步。
`;
}

export function buildReadme(config) {
  const sampleHost =
    config.environment === 'staging'
      ? `https://demo-staging.${config.siteDomainSuffix}`
      : `https://demo.${config.siteDomainSuffix}`;
  const stagingNotice =
    config.environment === 'staging'
      ? `
> 当前 README 来自 staging API。普通 \`xd-cell\` CLI 默认操作 production；staging 仅供平台维护者通过受控流程验证，不在公开 README 中提供可复制的发布 / secrets 命令。
`
      : '';
  const commandGuide =
    config.environment === 'staging'
      ? `staging 命令请使用维护流程提供的专用入口。`
      : `\`\`\`bash
xd-cell login
xd-cell detect ./dist --json
xd-cell deploy ./dist demo --dry-run --json
xd-cell deploy ./dist demo --visibility org
xd-cell teams
xd-cell deploy ./dist demo --team <teamId>
xd-cell deploy --config xd-cell.config.json
xd-cell status demo
xd-cell open demo
xd-cell access get demo
xd-cell access set demo --visibility acl --email user@xd.com
xd-cell secrets put demo API_TOKEN
echo "$API_TOKEN" | xd-cell secrets put demo API_TOKEN --stdin
xd-cell secrets delete demo API_TOKEN
\`\`\``;

  return `# XD Cell

XD Cell 是内部站点发布平台。用户通过 \`xd-cell\` CLI 发布构建目录或带自定义 Worker 入口的站点；平台负责登录、发布鉴权、子站 SSO、访问策略和运行隔离。

## 当前入口

| 配置 | 值 |
| ---- | -- |
| API | \`${config.apiBaseUrl}\` |
| Auth | \`${config.authBaseUrl}\` |
| Site suffix | \`${config.siteDomainSuffix}\` |
| Example site | \`${sampleHost}\` |
${stagingNotice}

## 常用命令

${commandGuide}

CI 或 agent 场景可以设置 \`XD_CELL_API_TOKEN\`，不要在仓库中保存 API token、CLI token 或 secret value。
\`xd-cell.config.json\` 只保存非敏感发布模板字段。
\`xd-cell teams\` 可查看当前用户所在团队及可用于 \`--team\` 的团队 ID。
\`vars\` 是站点级当前 runtime config，由 Worker deploy 同步，secret value 使用 \`xd-cell secrets put/delete\` 管理。
runtime bindings 只注入 Worker 发布；单个 var / secret value 当前限制为 8 KiB，单次 Worker 发布最多 64 个 runtime bindings。

## 安全边界

- 发布必须通过强认证。
- 子站访问由 router 执行 IP allowlist、visibility、SSO 和 ACL。
- \`internal\` 表示公司网络内匿名可访问，不代表互联网公开。
- \`acl\` 支持邮箱和部门路径 OR 授权；部门路径授权包含子部门。
- User Worker 不会收到平台 session cookie 或平台 secret。
- 平台能力通过独立 capability 和 gateway 暴露，不能把 router 注入的身份 token 当作通用能力凭证。
`;
}
