import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

function resolveDispatchContext(env) {
  return {
    publishingJobId: env.INPUT_PUBLISHING_JOB_ID || '',
    mode: env.INPUT_AGENT_MODE || 'initial',
    employeeSlug: env.INPUT_EMPLOYEE_SLUG || '',
    siteSlug: env.INPUT_SITE_SLUG || '',
    allowedPath: env.INPUT_ALLOWED_PATH || '',
    baseRef: env.INPUT_BASE_REF || env.DEFAULT_BASE_REF || 'staging',
    indexSnapshotId: env.INPUT_INDEX_SNAPSHOT_ID || '',
    issueNumber: env.INPUT_ISSUE_NUMBER || '',
    requestTitle: env.INPUT_REQUEST_TITLE || '',
    requestSummary: env.INPUT_REQUEST_SUMMARY || 'No summary provided.',
    callbackUrl: env.INPUT_CALLBACK_URL || env.DEFAULT_CALLBACK_URL || '',
    branchName: env.INPUT_BRANCH_NAME || '',
  };
}

export function resolvePagesAgentContext(env = process.env) {
  const context = resolveDispatchContext(env);
  const expectedAllowedPath =
    context.employeeSlug && context.siteSlug ? `sites/${context.employeeSlug}/${context.siteSlug}` : '';
  if (!context.allowedPath && expectedAllowedPath) {
    context.allowedPath = expectedAllowedPath;
  }

  return context;
}

function appendGithubEnv(name, value, env = process.env) {
  if (!env.GITHUB_ENV) return;
  const normalized = value === undefined || value === null ? '' : String(value);
  if (!normalized.includes('\n')) {
    appendFileSync(env.GITHUB_ENV, `${name}=${normalized}\n`);
    return;
  }

  const delimiter = `PAGES_${name}_${Date.now()}`;
  appendFileSync(env.GITHUB_ENV, `${name}<<${delimiter}\n${normalized}\n${delimiter}\n`);
}

export function writePagesAgentContext(context, env = process.env) {
  mkdirSync('.pages-artifacts', { recursive: true });
  writeFileSync('.pages-artifacts/job-context.json', `${JSON.stringify(context, null, 2)}\n`);

  const envMap = {
    PUBLISHING_JOB_ID: context.publishingJobId,
    AGENT_MODE: context.mode,
    EMPLOYEE_SLUG: context.employeeSlug,
    SITE_SLUG: context.siteSlug,
    ALLOWED_PATH: context.allowedPath,
    BASE_REF: context.baseRef,
    INDEX_SNAPSHOT_ID: context.indexSnapshotId,
    ISSUE_NUMBER: context.issueNumber,
    REQUEST_TITLE: context.requestTitle,
    REQUEST_SUMMARY: context.requestSummary,
    CALLBACK_URL: context.callbackUrl,
    PAGES_CALLBACK_URL: context.callbackUrl,
    BRANCH_NAME_OVERRIDE: context.branchName,
  };

  for (const [name, value] of Object.entries(envMap)) {
    appendGithubEnv(name, value, env);
  }
}

export function main(env = process.env) {
  const context = resolvePagesAgentContext(env);
  writePagesAgentContext(context, env);
  console.log('pages-agent context written');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
