const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const JOB_MARKER_PREFIX = 'PublishingJob:';
const SMOKE_MARKER_PREFIX = 'PagesSmokeIssue:';

export function parseRepoFullName(repoFullName) {
  const [owner, repo, extra] = String(repoFullName || '').split('/');
  if (!owner || !repo || extra) {
    throw new Error('repoFullName must use owner/repo format');
  }
  return { owner, repo };
}

export function githubApiUrl(config, pathname, searchParams = {}) {
  let baseUrl = String(config.apiBaseUrl || DEFAULT_GITHUB_API_BASE_URL);
  while (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  const url = new URL(`${baseUrl}${pathname}`);

  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function githubHeaders(config, extra = {}) {
  if (!config.token) {
    throw new Error('GitHub token is required');
  }

  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function githubRequest(fetchImpl, config, request) {
  const response = await fetchImpl(request.url, {
    method: request.method || 'GET',
    headers: githubHeaders(config, request.headers),
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    const message = body?.message || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`GitHub request failed: ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return { status: response.status, body };
}

export function allowedPathForJob(job) {
  return `sites/${job.employeeSlug}/${job.siteSlug}`;
}

export function branchNameForJob(job) {
  return `sites/job-${job.id}-${job.employeeSlug}-${job.siteSlug}`;
}

export function publishingJobMarker(jobId) {
  return `${JOB_MARKER_PREFIX} ${jobId}`;
}

export function smokeIssueMarker(scope) {
  return `${SMOKE_MARKER_PREFIX} ${scope}`;
}

export function buildPublishingIssue(job, options = {}) {
  const allowedPath = options.allowedPath || allowedPathForJob(job);
  const title = `[pages] ${job.employeeSlug}/${job.siteSlug}: ${job.title || job.intent || 'site request'}`;
  const summary = job.summary || job.brief || 'No summary provided.';

  return {
    title,
    labels: options.labels || ['pages-publishing-job', 'site-change'],
    body: [
      publishingJobMarker(job.id),
      '',
      `Source: ${job.source}`,
      `Requested by: ${job.requestedByType}:${job.requestedById}`,
      `Target: ${job.employeeSlug}/${job.siteSlug}`,
      `Allowed path: ${allowedPath}`,
      `Base ref: ${options.baseRef || ''}`,
      `Approval mode: ${job.approvalMode}`,
      'Pipeline: user-site publishing',
      'Platform deployment: out of scope',
      '',
      '## Requirement Summary',
      '',
      summary,
      '',
      '## Automation Boundary',
      '',
      `Automated changes for this job must stay under \`${allowedPath}/\`.`,
      'Do not modify platform code, GitHub Actions, Kubernetes manifests, Dockerfiles, or deployment secrets for this job.',
    ].join('\n'),
  };
}

export function buildSmokeIssue(job, options = {}) {
  const scope = options.scope || 'local-slack-smoke';
  const allowedPath = options.allowedPath || allowedPathForJob(job);

  return {
    title: options.title || `[pages-smoke] Slack issue intake (${scope})`,
    labels: [],
    body: [
      smokeIssueMarker(scope),
      '',
      'This issue is reused by local Slack smoke tests to avoid creating one GitHub issue per test message.',
      '',
      '## Latest Request',
      '',
      `PublishingJob: ${job.id}`,
      `Source: ${job.source}`,
      `Requested by: ${job.requestedByType}:${job.requestedById}`,
      `Target: ${job.employeeSlug}/${job.siteSlug}`,
      `Allowed path: ${allowedPath}`,
      'Pipeline: user-site publishing',
      'Platform deployment: out of scope',
      '',
      job.summary || job.brief || 'No summary provided.',
    ].join('\n'),
  };
}

export function buildSmokeIssueComment(job, options = {}) {
  const allowedPath = options.allowedPath || allowedPathForJob(job);

  return [
    `PublishingJob: ${job.id}`,
    '',
    `Source: ${job.source}`,
    `Requested by: ${job.requestedByType}:${job.requestedById}`,
    `Target: ${job.employeeSlug}/${job.siteSlug}`,
    `Allowed path: ${allowedPath}`,
    'Pipeline: user-site publishing',
    'Platform deployment: out of scope',
    '',
    job.summary || job.brief || 'No summary provided.',
  ].join('\n');
}

export function buildFollowupIssueComment(job, options = {}) {
  const allowedPath = options.allowedPath || allowedPathForJob(job);

  return [
    `PublishingJob: ${job.id}`,
    '',
    '## Slack Follow-up',
    '',
    `Source: ${job.source}`,
    `Requested by: ${job.requestedByType}:${job.requestedById}`,
    `Target: ${job.employeeSlug}/${job.siteSlug}`,
    `Allowed path: ${allowedPath}`,
    `Agent mode: ${options.mode || 'fix'}`,
    'Pipeline: user-site publishing',
    'Platform deployment: out of scope',
    '',
    job.summary || job.brief || 'No summary provided.',
  ].join('\n');
}

export function buildProjectIndexInputs(job, options = {}) {
  return {
    publishingJobId: job.id,
    siteProjectId: job.siteProjectId || '',
    allowedPath: options.allowedPath || allowedPathForJob(job),
    baseRef: options.baseRef || '',
    callbackUrl: options.callbackUrl || '',
    issueNumber: String(options.issueNumber || job.issueNumber || ''),
  };
}

export function buildPagesAgentInputs(job, options = {}) {
  return {
    publishingJobId: job.id,
    mode: options.mode || 'initial',
    employeeSlug: job.employeeSlug,
    siteSlug: job.siteSlug,
    allowedPath: options.allowedPath || allowedPathForJob(job),
    baseRef: options.baseRef || '',
    indexSnapshotId: options.indexSnapshotId || job.indexSnapshotId || '',
    issueNumber: String(options.issueNumber || job.issueNumber || ''),
    requestTitle: job.title || '',
    requestSummary: job.summary || job.brief || '',
    callbackUrl: options.callbackUrl || '',
    branchName: options.branchName || '',
  };
}

export function buildPagesPreviewInputs(job, options = {}) {
  return {
    publishingJobId: job.id,
    prNumber: String(options.prNumber || job.prNumber || ''),
    headSha: options.headSha || job.headSha || '',
    siteProjectId: job.siteProjectId || '',
    employeeSlug: job.employeeSlug || '',
    siteSlug: job.siteSlug || '',
    allowedPath: options.allowedPath || allowedPathForJob(job),
    previewSiteName: options.previewSiteName || '',
    previewHostname: options.previewHostname || '',
    callbackUrl: options.callbackUrl || '',
  };
}

export async function searchIssues(fetchImpl, config, query) {
  const url = githubApiUrl(config, '/search/issues', { q: query, per_page: 5 });
  const result = await githubRequest(fetchImpl, config, { url, method: 'GET' });
  return result.body?.items || [];
}

export async function findIssueByBodyMarker(fetchImpl, config, marker, options = {}) {
  const state = options.state ? String(options.state).toLowerCase() : '';
  const stateQualifier = state ? ` state:${state}` : '';
  const query = `repo:${config.repoFullName} "${marker}" in:body type:issue${stateQualifier}`;
  const issues = await searchIssues(fetchImpl, config, query);
  return (
    issues.find((issue) => {
      if (!issue.body?.includes(marker)) return false;
      return !state || !issue.state || String(issue.state).toLowerCase() === state;
    }) || null
  );
}

export async function findIssueByPublishingJob(fetchImpl, config, jobId) {
  return findIssueByBodyMarker(fetchImpl, config, publishingJobMarker(jobId));
}

export async function createIssue(fetchImpl, config, issue) {
  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const url = githubApiUrl(config, `/repos/${owner}/${repo}/issues`);
  const result = await githubRequest(fetchImpl, config, {
    url,
    method: 'POST',
    body: issue,
  });
  return result.body;
}

export async function createIssueComment(fetchImpl, config, issueNumber, body) {
  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const url = githubApiUrl(config, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`);
  const result = await githubRequest(fetchImpl, config, {
    url,
    method: 'POST',
    body: { body },
  });
  return result.body;
}

export async function appendFollowupIssueComment(fetchImpl, config, job, options = {}) {
  if (!job.issueNumber) return null;
  return createIssueComment(
    fetchImpl,
    config,
    job.issueNumber,
    buildFollowupIssueComment(job, { ...options, mode: options.mode || 'fix' })
  );
}

function shouldRetryIssueWithoutLabels(error, issue) {
  return Boolean(issue.labels?.length && /label/i.test(error.message));
}

export async function ensurePublishingIssue(fetchImpl, config, job, options = {}) {
  const existing = await findIssueByPublishingJob(fetchImpl, config, job.id);
  if (existing) return { issue: existing, created: false };

  const issueInput = buildPublishingIssue(job, options);
  let issue;
  try {
    issue = await createIssue(fetchImpl, config, issueInput);
  } catch (err) {
    if (!shouldRetryIssueWithoutLabels(err, issueInput)) throw err;
    issue = await createIssue(fetchImpl, config, { ...issueInput, labels: [] });
  }
  return { issue, created: true };
}

export async function ensureSmokeIssue(fetchImpl, config, job, options = {}) {
  const scope = options.scope || 'local-slack-smoke';
  const existing = await findIssueByBodyMarker(fetchImpl, config, smokeIssueMarker(scope), { state: 'open' });

  if (existing) {
    const comment = await createIssueComment(fetchImpl, config, existing.number, buildSmokeIssueComment(job, options));
    return { issue: existing, comment, created: false };
  }

  const issue = await createIssue(fetchImpl, config, buildSmokeIssue(job, options));
  return { issue, comment: null, created: true };
}

export async function dispatchWorkflow(fetchImpl, config, workflow) {
  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const workflowId = encodeURIComponent(workflow.workflowId);
  const url = githubApiUrl(config, `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`);
  await githubRequest(fetchImpl, config, {
    url,
    method: 'POST',
    body: {
      ref: workflow.ref,
      inputs: workflow.inputs || {},
    },
  });

  return { workflowId: workflow.workflowId, ref: workflow.ref, dispatched: true };
}
