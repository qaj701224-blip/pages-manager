import crypto from 'node:crypto';

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const JOB_MARKER_PREFIX = 'PublishingJob:';
const PLATFORM_DEV_MARKER_PREFIX = 'PlatformDevItem:';
const SMOKE_MARKER_PREFIX = 'PagesSmokeIssue:';
const GITHUB_APP_JWT_TTL_SECONDS = 9 * 60;
const GITHUB_APP_JWT_IAT_SKEW_SECONDS = 60;
const GITHUB_APP_INSTALLATION_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const installationTokenCache = new Map();

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

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(value) {
  const text = String(value || '').trim();
  return text ? text.replaceAll('\\n', '\n') : '';
}

function decodeBase64PrivateKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return Buffer.from(text, 'base64').toString('utf8');
}

function githubAppPrivateKey(config = {}) {
  return normalizePrivateKey(config.appPrivateKey) || normalizePrivateKey(decodeBase64PrivateKey(config.appPrivateKeyB64));
}

function githubAppConfigComplete(config = {}) {
  return Boolean(config.appId && config.appInstallationId && githubAppPrivateKey(config));
}

export function hasGithubAuthConfig(config = {}) {
  return Boolean(config.token || githubAppConfigComplete(config));
}

export function githubConfigFromEnv(env = {}, options = {}) {
  const tokenKeys = options.tokenKeys || ['GITHUB_APP_INSTALLATION_TOKEN', 'GITHUB_TOKEN'];
  const token = tokenKeys.map((key) => env[key]).find(Boolean) || '';
  return {
    apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_BASE_URL,
    token,
    repoFullName: env.GITHUB_REPO || env.GITHUB_REPOSITORY || '',
    appId: env.GITHUB_APP_ID || '',
    appInstallationId: env.GITHUB_APP_INSTALLATION_ID || '',
    appPrivateKey: env.GITHUB_APP_PRIVATE_KEY || '',
    appPrivateKeyB64: env.GITHUB_APP_PRIVATE_KEY_B64 || '',
  };
}

export function requireGithubConfig(config = {}, options = {}) {
  const name = options.name || 'GitHub';
  if (!config.repoFullName) throw new Error(`${name} repo is required`);
  if (!hasGithubAuthConfig(config)) throw new Error(`${name} token or GitHub App credentials are required`);
  return config;
}

function githubAppJwt(config, now = Date.now()) {
  const iat = Math.floor(now / 1000) - GITHUB_APP_JWT_IAT_SKEW_SECONDS;
  const exp = iat + GITHUB_APP_JWT_TTL_SECONDS;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat, exp, iss: String(config.appId) }));
  const input = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), githubAppPrivateKey(config)).toString('base64url');
  return `${input}.${signature}`;
}

function githubAppCacheKey(config = {}) {
  return [
    String(config.apiBaseUrl || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, ''),
    String(config.appId || ''),
    String(config.appInstallationId || ''),
  ].join('|');
}

function parseExpiresAt(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function clearGithubAppInstallationTokenCache() {
  installationTokenCache.clear();
}

export async function resolveGithubToken(fetchImpl, config = {}, options = {}) {
  if (!githubAppConfigComplete(config)) {
    if (config.token) return config.token;
    throw new Error('GitHub token is required');
  }

  const now = options.now ?? Date.now();
  const cacheKey = githubAppCacheKey(config);
  const cached = installationTokenCache.get(cacheKey);
  if (cached?.token && cached.expiresAt - GITHUB_APP_INSTALLATION_TOKEN_REFRESH_SKEW_MS > now) {
    return cached.token;
  }

  const url = githubApiUrl(config, `/app/installations/${encodeURIComponent(config.appInstallationId)}/access_tokens`);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubAppJwt(config, now)}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    const message = body?.message || response.statusText || `HTTP ${response.status}`;
    const error = new Error(`GitHub App installation token request failed: ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  if (!body?.token) {
    throw new Error('GitHub App installation token response did not include a token');
  }

  const expiresAt = parseExpiresAt(body.expires_at);
  installationTokenCache.set(cacheKey, { token: body.token, expiresAt });
  return body.token;
}

export async function githubHeaders(fetchImpl, config, extra = {}) {
  const token = await resolveGithubToken(fetchImpl, config);

  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
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
    headers: await githubHeaders(fetchImpl, config, request.headers),
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

export function platformDevItemMarker(itemId) {
  return `${PLATFORM_DEV_MARKER_PREFIX} ${itemId}`;
}

export function smokeIssueMarker(scope) {
  return `${SMOKE_MARKER_PREFIX} ${scope}`;
}

function safeText(value, fallback = '未提供') {
  const text = String(value || '').trim();
  return text || fallback;
}

const SECRET_FIELD_NAME_PATTERN =
  [
    '(?:[A-Za-z0-9]+[_-])*',
    '(?:api[_-]?key|secret(?:[_-]access)?[_-]?key|private[_-]?key|secret|token|password|passwd|pwd)',
    '(?:[_-][A-Za-z0-9]+)*',
  ].join('');
const jsonSecretFieldPattern = new RegExp(
  `((["'])(?:${SECRET_FIELD_NAME_PATTERN})\\2\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
  'gi'
);
const quotedSecretAssignmentPattern = new RegExp(
  `\\b(${SECRET_FIELD_NAME_PATTERN})\\b\\s*([:=])\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
  'gi'
);
const secretAssignmentPattern = new RegExp(`\\b(${SECRET_FIELD_NAME_PATTERN})\\b\\s*([:=])\\s*[^"',\\s}]+`, 'gi');

function redactPublicIssueText(value = '') {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_APP_TOKEN]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(jsonSecretFieldPattern, (_, prefix, _keyQuote, valueText) => {
      const quote = valueText[0];
      return `${prefix}${quote}[REDACTED_SECRET]${quote}`;
    })
    .replace(quotedSecretAssignmentPattern, (_, key, operator, valueText) => {
      const quote = valueText[0];
      return `${key}${operator}${quote}[REDACTED_SECRET]${quote}`;
    })
    .replace(secretAssignmentPattern, '$1$2[REDACTED_SECRET]');
}

function safePublicText(value, fallback = '未提供') {
  return safeText(redactPublicIssueText(value), fallback);
}

function workflowInputValue(value, maxLength = 60000) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function workflowInputs(inputs = {}) {
  return Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, workflowInputValue(value)]));
}

function requesterProfileForJob(job = {}) {
  const profile = job.requesterProfile || job.requester_profile || job.requester || {};
  const slackUserId = profile.slackUserId || profile.slack_user_id || job.slackThread?.userId || '';
  return {
    name: profile.displayName || profile.display_name || profile.realName || profile.real_name || profile.name || '',
    email: profile.email || '',
    slackTeamId: profile.slackTeamId || profile.slack_team_id || job.slackThread?.teamId || '',
    slackUserId,
  };
}

function requesterLines(job = {}) {
  const profile = requesterProfileForJob(job);
  return [
    `- 发起人：${safeText(profile.name, '未获取 Slack 昵称')}`,
    `- 联系方式：已由平台保留，不写入公开 issue。`,
  ];
}

function sourceLines(job = {}) {
  if (job.source !== 'slack') {
    return [`- 来源：${safeText(job.source)}`];
  }

  return [`- 来源：Slack`, `- Slack thread：已由平台保留，不写入公开 issue。`];
}

function automationMetadataLines(job, options = {}) {
  const allowedPath = options.allowedPath || allowedPathForJob(job);
  return [
    publishingJobMarker(job.id),
    `Source: ${job.source}`,
    `Requester: managed-by-pages-gateway`,
    `Target: ${job.employeeSlug}/${job.siteSlug}`,
    `Allowed path: ${allowedPath}`,
    `Base ref: ${options.baseRef || ''}`,
    `Approval mode: ${job.approvalMode}`,
    'Pipeline: user-site publishing',
    'Platform deployment: out of scope',
  ];
}

function platformDevAutomationMetadataLines(item, options = {}) {
  return [
    platformDevItemMarker(item.id),
    `Lane: platform-dev`,
    `Source: ${item.source}`,
    `Requester: managed-by-pages-gateway`,
    `IssueType: ${item.issueType}`,
    `Areas: ${(item.areas || []).join(', ')}`,
    `Risk: ${item.risk}`,
    `AgentEligible: ${item.agentEligible ? 'true' : 'false'}`,
    `AutoDevStatus: ${item.autoDevStatus || 'pending'}`,
    `Base ref: ${options.baseRef || ''}`,
    'Pipeline: platform development',
    'Site publishing: out of scope',
  ];
}

export function buildPublishingIssue(job, options = {}) {
  const allowedPath = options.allowedPath || allowedPathForJob(job);
  const title = `[pages] ${job.employeeSlug}/${job.siteSlug}：${safePublicText(job.title || job.intent, '站点发布需求')}`;
  const summary = safePublicText(job.summary || job.brief, '未提供需求摘要。');

  return {
    title,
    labels: options.labels || ['pages-publishing-job', 'site-change'],
    body: [
      `<!-- pages-manager:job_id=${job.id} -->`,
      '',
      '## 发布需求',
      '',
      summary,
      '',
      '## 发起人',
      '',
      ...requesterLines(job),
      '',
      '## 目标站点',
      '',
      `- 归属目录：\`${job.employeeSlug}\``,
      `- 站点名称：\`${job.siteSlug}\``,
      `- 允许修改目录：\`${allowedPath}/\``,
      `- Base ref：${options.baseRef ? `\`${options.baseRef}\`` : '未指定'}`,
      '',
      '## 来源上下文',
      '',
      ...sourceLines(job),
      '',
      '## 自动化边界',
      '',
      `- Coding Agent 只能修改 \`${allowedPath}/\` 下的文件。`,
      '- 不允许修改平台代码、GitHub Actions、Kubernetes manifests、Dockerfile、部署脚本或任何 secret 配置。',
      '- 本 issue 只驱动个人站点 preview 流程，不触发 production deploy。',
      '',
      '## 验收标准',
      '',
      '- 生成或更新个人网站内容，并保留用户需求里的关键标识。',
      '- PR 只包含允许目录下的站点文件变更。',
      '- site-check 和 Review Agent gate 通过后生成 preview URL。',
      '- 用户可以继续在原 Slack thread 里追加修改意见。',
      '',
      '## 自动化元数据',
      '',
      '```text',
      ...automationMetadataLines(job, options),
      '```',
    ].join('\n'),
  };
}

export function buildPlatformDevIssue(item, options = {}) {
  const issueType = item.issueType || 'type:dev';
  const areas = Array.isArray(item.areas) && item.areas.length ? item.areas : ['area:platform'];
  const risk = item.risk || 'risk:medium';
  const title = `[pages-platform] ${safePublicText(item.title, '平台改造需求')}`;
  const summary = safePublicText(item.summary || item.brief, '未提供需求摘要。');

  return {
    title,
    labels: options.labels || ['pages-platform-dev', issueType, risk, ...areas],
    body: [
      `<!-- pages-manager:platform_dev_item_id=${item.id} -->`,
      '',
      '## 类型',
      '',
      issueType,
      '',
      '## 背景 / 用户原话',
      '',
      summary,
      '',
      '## 目标',
      '',
      safePublicText(item.title, 'pages-manager 平台能力改造'),
      '',
      '## 范围',
      '',
      '- Lane: platform-dev',
      `- Areas: ${areas.join(', ')}`,
      '- Repo 范围：全目录，按风险、手动“自动开发”触发、CI、review 和 GitHub Rulesets 控制。',
      '',
      '## 验收标准',
      '',
      '- PR 只包含和本 issue 直接相关的代码、测试、文档或工作流改动。',
      '- 修改必须有对应测试或清晰的验证说明。',
      '- 不提交 secret、真实 token、本地 env、构建缓存或大文件。',
      '- 默认只创建 GitHub issue；必须由发起人在 Slack 进度卡中手动点击「自动开发」后才进入自动开发。',
      '- 涉及 CI/CD、K8s、Dockerfile、生产部署、权限或 token 流程时，仍需按仓库 review、CI 和规则集约束处理。',
      '',
      '## 风险',
      '',
      risk,
      '',
      '## 自动化策略',
      '',
      `- agentEligible: ${item.agentEligible ? 'true' : 'false'}`,
      `- autoDevStatus: ${item.autoDevStatus || 'pending'}`,
      item.autoDevReason ? `- autoDevReason: ${item.autoDevReason}` : null,
      '',
      '## 发起人',
      '',
      ...requesterLines(item),
      '',
      '## 来源上下文',
      '',
      ...sourceLines(item),
      '',
      '## 自动化元数据',
      '',
      '```text',
      ...platformDevAutomationMetadataLines(item, options),
      '```',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  };
}

export function buildSmokeIssue(job, options = {}) {
  const scope = options.scope || 'local-slack-smoke';
  const allowedPath = options.allowedPath || allowedPathForJob(job);
  const summary = safePublicText(job.summary || job.brief, '未提供需求摘要。');

  return {
    title: options.title || `[pages-smoke] Slack 发布任务验证（${scope}）`,
    labels: [],
    body: [
      smokeIssueMarker(scope),
      '',
      '这个 issue 用于复用 Slack smoke 测试入口，避免每条测试消息都创建一个新的 GitHub issue。',
      '',
      '## 最新发布需求',
      '',
      summary,
      '',
      '## 发起人',
      '',
      ...requesterLines(job),
      '',
      '## 目标和边界',
      '',
      `- 目标站点：\`${job.employeeSlug}/${job.siteSlug}\``,
      `- 允许修改目录：\`${allowedPath}/\``,
      '- 只允许用户站点发布流程使用，不允许修改平台或部署配置。',
      '',
      '## 自动化元数据',
      '',
      '```text',
      ...automationMetadataLines(job, options),
      '```',
    ].join('\n'),
  };
}

export function buildSmokeIssueComment(job, options = {}) {
  return [
    '## 新的 Slack smoke 发布请求',
    '',
    safePublicText(job.summary || job.brief, '未提供需求摘要。'),
    '',
    '## 发起人',
    '',
    ...requesterLines(job),
    '',
    '## 自动化元数据',
    '',
    '```text',
    ...automationMetadataLines(job, options),
    '```',
  ].join('\n');
}

export function buildFollowupIssueComment(job, options = {}) {
  return [
    '## Slack 追加修改',
    '',
    safePublicText(job.summary || job.brief, '未提供追加说明。'),
    '',
    '## 发起人',
    '',
    ...requesterLines(job),
    '',
    '## 自动化元数据',
    '',
    '```text',
    ...automationMetadataLines(job, options),
    `Agent mode: ${options.mode || 'fix'}`,
    '```',
  ].join('\n');
}

export function buildPlatformDevFollowupComment(item, options = {}) {
  return [
    '## 追加说明',
    '',
    safePublicText(options.feedback || item.summary || item.brief, '未提供追加说明。'),
    '',
    '## 自动化策略',
    '',
    `- mode: ${options.mode || 'fix'}`,
    `- risk: ${item.risk || 'risk:medium'}`,
    `- autoDevTriggered: ${options.autoDevTriggered ? 'true' : 'false'}`,
    '',
    '## 自动化元数据',
    '',
    '```text',
    ...platformDevAutomationMetadataLines(item, options),
    `Agent mode: ${options.mode || 'fix'}`,
    '```',
  ].join('\n');
}

export function buildProjectIndexInputs(job, options = {}) {
  return workflowInputs({
    publishingJobId: job.id,
    siteProjectId: job.siteProjectId || '',
    allowedPath: options.allowedPath || allowedPathForJob(job),
    baseRef: options.baseRef || '',
    callbackUrl: options.callbackUrl || '',
    issueNumber: String(options.issueNumber || job.issueNumber || ''),
  });
}

export function buildPagesAgentInputs(job, options = {}) {
  return workflowInputs({
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
  });
}

export function buildPagesPreviewInputs(job, options = {}) {
  return workflowInputs({
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
  });
}

export function buildPlatformAgentInputs(item, options = {}) {
  const autoDevTriggered =
    options.autoDevTriggered !== undefined
      ? Boolean(options.autoDevTriggered)
      : item.autoDevStatus === 'triggered';
  return {
    platformDevItemId: item.id,
    mode: options.mode || 'initial',
    issueNumber: String(options.issueNumber || item.githubIssueNumber || ''),
    prNumber: String(options.prNumber || item.githubPrNumber || ''),
    headSha: options.headSha || item.headSha || '',
    requestTitle: item.title || '',
    requestSummary: item.summary || item.brief || '',
    issueType: item.issueType || 'type:dev',
    areas: (item.areas || []).join(','),
    risk: item.risk || 'risk:medium',
    autoDevTriggered: autoDevTriggered ? 'true' : 'false',
    baseRef: options.baseRef || item.baseRef || '',
    branchName: options.branchName || item.branchName || '',
    callbackUrl: options.callbackUrl || '',
    reviewContext: options.reviewContext || item.reviewContext || '',
    memoryContext: options.memoryContext || item.memoryContext || '',
    statusContext: options.statusContext || item.statusContext || '',
    followupContext: options.followupContext || item.followupContext || '',
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

export async function findIssueByPlatformDevItem(fetchImpl, config, itemId) {
  return findIssueByBodyMarker(fetchImpl, config, platformDevItemMarker(itemId));
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

export async function appendPlatformDevFollowupIssueComment(fetchImpl, config, item, options = {}) {
  const issueNumber = options.issueNumber || item.githubIssueNumber;
  if (!issueNumber) return null;
  return createIssueComment(
    fetchImpl,
    config,
    issueNumber,
    buildPlatformDevFollowupComment(item, { ...options, mode: options.mode || 'fix' })
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

export async function ensurePlatformDevIssue(fetchImpl, config, item, options = {}) {
  const existing = await findIssueByPlatformDevItem(fetchImpl, config, item.id);
  if (existing) return { issue: existing, created: false };

  const issueInput = buildPlatformDevIssue(item, options);
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
      inputs: workflowInputs(workflow.inputs || {}),
    },
  });

  return { workflowId: workflow.workflowId, ref: workflow.ref, dispatched: true };
}
