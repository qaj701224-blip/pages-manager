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
  const envFlag = config.environment === 'production' ? '' : ` --env ${config.environment}`;
  const deployEnvFlag = config.environment === 'production' ? '' : ` --env ${config.environment}`;

  return `---
name: pages-v2
description: Deploy static sites, SPA apps, or custom Workers to XD Pages v2 through the local CLI.
version: 0.1.0
---

# XD Pages v2 CLI Skill

你是 XD Pages v2 部署助手。v2 只通过本地 \`pages\` CLI 操作，不手写 HTTP 请求，不拼接底层 API，不要求用户理解平台基础设施。

## 环境

- API: \`${config.apiBaseUrl}\`
- Auth: \`${config.authBaseUrl}\`
- Site suffix: \`${config.siteDomainSuffix}\`

## 登录

优先使用浏览器登录：

\`\`\`bash
pages login${envFlag}
\`\`\`

CI 或 agent 环境使用平台签发的 access key：

\`\`\`bash
PAGES_ACCESS_KEY=<access-key> pages deploy <dir>${deployEnvFlag} --site <site-id> --json
\`\`\`

不要把 CLI token、access key、cookie、SSO code 或平台能力写入项目文件、日志、README、截图或聊天消息。

## 发布

\`\`\`bash
pages deploy <dir>${deployEnvFlag} --slug <site-slug> --visibility org
pages deploy <dir>${deployEnvFlag} --slug <site-slug> --visibility org --save-config
pages status${deployEnvFlag}
pages open${deployEnvFlag}
pages rollback <version-id>${deployEnvFlag}
\`\`\`

可见性只使用 v2 支持的值：\`public\`、\`org\`、\`acl\`、\`owner\`、\`disabled\`。第一版 \`public\` 仍受公司网络访问限制。
\`pages deploy\` 默认不写 \`.pages.json\`；需要保存非敏感项目绑定时显式加 \`--save-config\`。
使用 \`PAGES_ACCESS_KEY\` 时不能创建站点，必须传 \`--site <site-id>\` 或已有当前环境的 \`.pages.json\`。

## 硬性规则

1. 只调用 \`pages\` CLI。
2. 不使用旧 token header。
3. 不把 v2 CLI 指向旧 v1 域名。
4. 不读取或提交本地 SSO 参考文件、env 文件或 secret 文件。
5. 失败时先把 CLI 的错误码和 action 原样解释给用户，再建议下一步。
`;
}

export function buildReadme(config) {
  const envFlag = config.environment === 'production' ? '' : ` --env ${config.environment}`;
  const sampleHost =
    config.environment === 'staging'
      ? `https://demo-staging.${config.siteDomainSuffix}`
      : `https://demo.${config.siteDomainSuffix}`;

  return `# XD Pages v2

XD Pages v2 是新的内部站点发布平台。用户通过 \`pages\` CLI 发布 static、SPA 或 custom Worker；平台负责登录、发布鉴权、子站 SSO、访问策略和运行隔离。

## 当前环境

| 配置 | 值 |
| ---- | -- |
| Environment | \`${config.environment}\` |
| API | \`${config.apiBaseUrl}\` |
| Auth | \`${config.authBaseUrl}\` |
| Site suffix | \`${config.siteDomainSuffix}\` |
| Example site | \`${sampleHost}\` |

## 常用命令

\`\`\`bash
pages login${envFlag}
pages deploy ./dist${envFlag} --slug demo --visibility org
pages deploy ./dist${envFlag} --slug demo --visibility org --save-config
pages status${envFlag}
pages open${envFlag}
pages rollback <version-id>${envFlag}
\`\`\`

CI 使用 \`PAGES_ACCESS_KEY\` 和显式 \`--site <site-id>\`，不要在仓库中保存 access key 或 CLI token。
\`pages deploy\` 默认不写 \`.pages.json\`；需要保存非敏感项目绑定时显式加 \`--save-config\`。

## 安全边界

- 发布必须通过 v2 强认证。
- 子站访问由 router 执行 IP allowlist、visibility、SSO 和 ACL。
- \`public\` 只表示公司网络内匿名可访问，不代表互联网公开。
- User Worker 不会收到平台 session cookie 或平台 secret。
- 平台能力通过独立 capability 和 gateway 暴露，不能把 router 注入的身份 token 当作通用能力凭证。
`;
}
