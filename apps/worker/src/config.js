import { githubConfigFromEnv, requireGithubConfig } from '@xd/git-client';

function readBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function readWorkerConfig(env = process.env) {
  const gatewayUrl = env.PAGES_GATEWAY_URL || 'http://localhost:8788';
  const internalCallbackUrl =
    env.PAGES_WORKER_CALLBACK_URL || `${gatewayUrl.replace(/\/+$/, '')}/internal/executor-callback`;
  const workflowRef = env.PAGES_WORKFLOW_REF || env.GITHUB_REF_NAME || 'master';
  const platformWorkflowRef = env.PAGES_PLATFORM_WORKFLOW_REF || env.GITHUB_REF_NAME || workflowRef;

  return {
    executorMode: env.PAGES_EXECUTOR_MODE || 'actions',
    issueMode: env.PAGES_ISSUE_MODE || 'per_job',
    smokeIssueScope: env.PAGES_SMOKE_ISSUE_SCOPE || 'local-slack-smoke',
    prMode: env.PAGES_PR_MODE || 'per_job',
    smokePrBranch: env.PAGES_SMOKE_PR_BRANCH || '',
    workflowRef,
    platformWorkflowRef,
    baseRef: env.PAGES_BASE_REF || env.PAGES_PR_BASE_REF || 'staging',
    platformBaseRef: env.PAGES_PLATFORM_BASE_REF || env.PAGES_PLATFORM_PR_BASE_REF || platformWorkflowRef,
    previewMode: env.PAGES_PREVIEW_MODE || 'actions',
    previewHostnamePattern: env.PAGES_PREVIEW_HOSTNAME_PATTERN || '',
    previewSiteNamePattern: env.PAGES_PREVIEW_SITE_NAME_PATTERN || 'pm-pr-{prNumber}-{employeeSlug}-{siteSlug}',
    previewTokenPattern: env.PAGES_PREVIEW_TOKEN_PATTERN || '',
    pagesApi: env.PAGES_API || 'https://api-staging.workers.xd.team',
    pagesToken: env.PAGES_PREVIEW_TOKEN || env.PAGES_TOKEN || '',
    previewIpRestrict: readBooleanEnv(env.PAGES_PREVIEW_IP_RESTRICT, true),
    callbackUrl: env.PAGES_GATEWAY_CALLBACK_URL || `${gatewayUrl.replace(/\/+$/, '')}/internal/executor-callback`,
    workerCallbackUrl: internalCallbackUrl,
    callbackToken: env.INTERNAL_CALLBACK_TOKEN || '',
    workerSharedSecret: env.PAGES_WORKER_SHARED_SECRET || '',
    github: requireGithubConfig(githubConfigFromEnv(env), { name: 'GitHub' }),
  };
}
