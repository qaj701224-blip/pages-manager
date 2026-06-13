function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function readWorkerConfig(env = process.env) {
  const gatewayUrl = env.PAGES_GATEWAY_URL || 'http://localhost:8788';

  return {
    executorMode: env.PAGES_EXECUTOR_MODE || 'actions',
    issueMode: env.PAGES_ISSUE_MODE || 'per_job',
    smokeIssueScope: env.PAGES_SMOKE_ISSUE_SCOPE || 'local-slack-smoke',
    prMode: env.PAGES_PR_MODE || 'per_job',
    smokePrBranch: env.PAGES_SMOKE_PR_BRANCH || '',
    workflowRef: env.PAGES_WORKFLOW_REF || env.GITHUB_REF_NAME || 'master',
    baseRef: env.PAGES_BASE_REF || env.PAGES_PR_BASE_REF || 'staging',
    previewMode: env.PAGES_PREVIEW_MODE || 'actions',
    previewHostnamePattern: env.PAGES_PREVIEW_HOSTNAME_PATTERN || '',
    previewSiteNamePattern: env.PAGES_PREVIEW_SITE_NAME_PATTERN || 'pm-pr-{prNumber}-{employeeSlug}-{siteSlug}',
    pagesApi: env.PAGES_API || 'https://api-staging.workers.xd.team',
    pagesToken: env.PAGES_PREVIEW_TOKEN || env.PAGES_TOKEN || '',
    previewIpRestrict: env.PAGES_PREVIEW_IP_RESTRICT === 'true',
    callbackUrl: env.PAGES_GATEWAY_CALLBACK_URL || `${gatewayUrl.replace(/\/+$/, '')}/internal/executor-callback`,
    callbackToken: env.INTERNAL_CALLBACK_TOKEN || '',
    workerSharedSecret: env.PAGES_WORKER_SHARED_SECRET || '',
    github: {
      apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || 'https://api.github.com',
      token: required(env.GITHUB_APP_INSTALLATION_TOKEN || env.GITHUB_TOKEN, 'GITHUB_APP_INSTALLATION_TOKEN'),
      repoFullName: required(env.GITHUB_REPO || env.GITHUB_REPOSITORY, 'GITHUB_REPO'),
    },
  };
}
