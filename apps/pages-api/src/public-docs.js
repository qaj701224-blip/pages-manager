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

  return `---
name: pages
description: Deploy static sites, SPA apps, or custom Workers to XD Pages through the local CLI.
version: 0.1.0
---

# XD Pages CLI Skill

你是 XD Pages 部署助手。只通过本地 \`pages\` CLI 操作，不手写 HTTP 请求，不拼接底层 API，不要求用户理解平台基础设施。

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
pages deploy <dir> <site>${envFlag} --access-key <access-key> --json
\`\`\`

不要把 CLI token、access key、cookie、SSO code 或平台能力写入项目文件、日志、README、截图或聊天消息。

## 发布

\`\`\`bash
pages deploy <dir> <site>${envFlag} --visibility org
pages deploy --config pages.config.json${envFlag}
pages status <site>${envFlag}
pages open <site>${envFlag}
pages rollback <site> <version-id>${envFlag}
\`\`\`

可见性只使用：\`internal\`、\`org\`、\`acl\`、\`owner\`、\`disabled\`。第一版所有可见性都受公司网络 / VPN / 办公网出口 IP allowlist 约束。
\`--config <file>\` 是一次性输入，不自动发现、不写回、不保存到本地 profile，且不能包含 token、access key、cookie 或 secret。
使用 \`--access-key <key>\` 时 access key 只对本次命令生效，CLI 不应把它写入本地状态。

## 硬性规则

1. 只调用 \`pages\` CLI。
2. 不使用旧 token header。
3. 不把 CLI 指向旧版域名。
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

  return `# XD Pages

XD Pages 是内部站点发布平台。用户通过 \`pages\` CLI 发布 static、SPA 或 custom Worker；平台负责登录、发布鉴权、子站 SSO、访问策略和运行隔离。

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
pages deploy ./dist demo${envFlag} --visibility org
pages deploy --config pages.config.json${envFlag}
pages status demo${envFlag}
pages open demo${envFlag}
pages rollback demo <version-id>${envFlag}
\`\`\`

CI 使用显式 \`--access-key <key>\` 和站点名位置参数，不要在仓库中保存 access key 或 CLI token。
\`--config <file>\` 是一次性输入，不自动发现、不写回、不保存到本地 profile，且不能包含敏感字段。

## 安全边界

- 发布必须通过强认证。
- 子站访问由 router 执行 IP allowlist、visibility、SSO 和 ACL。
- \`internal\` 表示公司网络内匿名可访问，不代表互联网公开。
- User Worker 不会收到平台 session cookie 或平台 secret。
- 平台能力通过独立 capability 和 gateway 暴露，不能把 router 注入的身份 token 当作通用能力凭证。
`;
}
