import {
  githubApiUrl,
  githubRequest,
  parseRepoFullName,
} from '@xd/git-client';

import { redactSecretLikeText } from '../slack/text.js';

const MAX_RUN_CANDIDATES = 30;
const MAX_FAILED_JOBS = 3;
const MAX_LOG_BYTES = 180_000;
const MAX_EXCERPT_LINES = 6;

const PLATFORM_WORKFLOWS = new Set(['platform-agent.yml', 'pr-platform.yml', 'ci.yml']);
const SITE_PR_CHECK_WORKFLOWS = ['pr-classify.yml', 'pr-platform.yml', 'pr-site.yml'];
const SITE_WORKFLOWS_BY_STATUS = {
  indexing: ['project-index.yml'],
  generating_page: ['pages-agent.yml'],
  patch_generated: ['pages-agent.yml'],
  branch_committed: ['pages-agent.yml'],
  pr_created: ['pages-agent.yml', ...SITE_PR_CHECK_WORKFLOWS],
  reviewing: ['pages-agent.yml', ...SITE_PR_CHECK_WORKFLOWS],
  changes_requested: ['pages-agent.yml', 'pr-platform.yml', 'pr-site.yml'],
  fixing: ['pages-agent.yml'],
  previewing: ['pages-preview.yml'],
  preview_deployed: ['pages-preview.yml'],
  failed: ['pages-agent.yml', 'pages-preview.yml', 'project-index.yml', ...SITE_PR_CHECK_WORKFLOWS],
};

function githubActionsConfig(env = {}) {
  const token = env.GITHUB_APP_INSTALLATION_TOKEN || env.GITHUB_TOKEN;
  const repoFullName = env.GITHUB_REPO || env.GITHUB_REPOSITORY;
  if (!token || !repoFullName) return null;
  return {
    apiBaseUrl: env.GITHUB_ENTERPRISE_API_BASE_URL || env.GITHUB_API_BASE_URL || 'https://api.github.com',
    token,
    repoFullName,
  };
}

function fetchImplFromEnv(env = {}) {
  return env.GITHUB_FETCH || env.GITHUB_STATUS_FETCH || fetch;
}

function workflowFileFromRun(run = {}) {
  const path = String(run.path || run.workflow_path || '');
  return path.split('/').pop() || '';
}

function workflowDisplayName(run = {}) {
  return run.name || workflowFileFromRun(run) || `run ${run.id}`;
}

function workItemKind(item = {}) {
  return item.workItemKind || (item.githubIssueNumber !== undefined ? 'platform_dev' : 'site_publishing');
}

function workflowFilesForWorkItem(item = {}) {
  if (workItemKind(item) === 'platform_dev') return [...PLATFORM_WORKFLOWS];
  const files = SITE_WORKFLOWS_BY_STATUS[item.status] || ['pages-agent.yml', 'pages-preview.yml', 'project-index.yml'];
  const workflowName = item.workflowName || item.workflow_name;
  return workflowName && !files.includes(workflowName) ? [workflowName, ...files] : files;
}

function startedAfter(item = {}, events = []) {
  const timestamps = [
    item.createdAt,
    ...events.map((event) => event.createdAt || event.updatedAt).filter(Boolean),
  ];
  const dates = timestamps
    .map((value) => new Date(value).getTime())
    .filter((time) => Number.isFinite(time));
  if (!dates.length) return null;
  return Math.min(...dates) - 5 * 60 * 1000;
}

function runMatchesItem(run = {}, item = {}, preferredFiles = new Set(), options = {}) {
  const file = workflowFileFromRun(run);
  if (preferredFiles.size && file && !preferredFiles.has(file)) return false;
  const branch = item.branchName || item.branch_name || null;
  const headSha = item.headSha || item.head_sha || null;
  if (headSha && run.head_sha && String(run.head_sha).startsWith(String(headSha).slice(0, 12))) return true;
  if (branch && run.head_branch === branch) return true;
  if (!branch && !headSha && options.startedAfter) {
    const created = new Date(run.created_at || run.run_started_at || 0).getTime();
    return Number.isFinite(created) && created >= options.startedAfter;
  }
  return !branch && !headSha;
}

function scoreRun(run = {}, item = {}) {
  let score = 0;
  const file = workflowFileFromRun(run);
  const branch = item.branchName || item.branch_name || null;
  const headSha = item.headSha || item.head_sha || null;
  if (headSha && run.head_sha && String(run.head_sha).startsWith(String(headSha).slice(0, 12))) score += 80;
  if (branch && run.head_branch === branch) score += 60;
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'cancelled') score += 40;
  if (run.status === 'in_progress' || run.status === 'queued') score += 30;
  if (file === 'platform-agent.yml' || file === 'pages-agent.yml') score += 20;
  if (file === 'pr-platform.yml' || file === 'pr-site.yml') score += 12;
  if (
    workItemKind(item) === 'site_publishing' &&
    SITE_PR_CHECK_WORKFLOWS.includes(file) &&
    ['failed', 'changes_requested', 'reviewing', 'pr_created'].includes(item.status) &&
    ['failure', 'timed_out', 'cancelled'].includes(String(run.conclusion || '').toLowerCase())
  ) {
    score += 35;
  }
  const created = new Date(run.created_at || run.run_started_at || 0).getTime();
  if (Number.isFinite(created)) score += Math.min(created / 1e13, 10);
  return score;
}

async function listWorkflowRuns(fetchImpl, config, item = {}, events = []) {
  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const seen = new Set();
  const runs = [];
  let lastSearchError = null;
  if (item.workflowRunId || item.workflow_run_id) {
    const runId = item.workflowRunId || item.workflow_run_id;
    const url = githubApiUrl(config, `/repos/${owner}/${repo}/actions/runs/${runId}`);
    const result = await githubRequest(fetchImpl, config, { url });
    if (result.body?.id) {
      seen.add(result.body.id);
      runs.push(result.body);
    }
  }

  const preferredFiles = new Set(workflowFilesForWorkItem(item));
  const searches = [];
  const headSha = item.headSha || item.head_sha || null;
  const branch = item.branchName || item.branch_name || null;
  const hasPinnedRun = Boolean(item.workflowRunId || item.workflow_run_id);
  if (headSha) searches.push({ head_sha: headSha, per_page: MAX_RUN_CANDIDATES });
  if (branch) searches.push({ branch, per_page: MAX_RUN_CANDIDATES });
  if (!hasPinnedRun || (!headSha && !branch)) searches.push({ per_page: MAX_RUN_CANDIDATES });

  for (const search of searches) {
    const url = githubApiUrl(config, `/repos/${owner}/${repo}/actions/runs`, search);
    let result;
    try {
      result = await githubRequest(fetchImpl, config, { url });
    } catch (err) {
      lastSearchError = err;
      if (runs.length) continue;
      throw err;
    }
    for (const run of result.body?.workflow_runs || []) {
      if (!run?.id || seen.has(run.id)) continue;
      seen.add(run.id);
      runs.push(run);
    }
  }
  if (!runs.length && lastSearchError) throw lastSearchError;

  const floor = startedAfter(item, events);
  return runs
    .filter((run) => runMatchesItem(run, item, preferredFiles, { startedAfter: floor }))
    .sort((left, right) => scoreRun(right, item) - scoreRun(left, item))
    .slice(0, MAX_RUN_CANDIDATES);
}

async function listRunJobs(fetchImpl, config, runId) {
  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const url = githubApiUrl(config, `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { per_page: 100 });
  const result = await githubRequest(fetchImpl, config, { url });
  return result.body?.jobs || [];
}

async function readJobLog(fetchImpl, config, jobId) {
  const { owner, repo } = parseRepoFullName(config.repoFullName);
  const url = githubApiUrl(config, `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'text/plain',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const error = new Error(`GitHub job log request failed: ${response.statusText || response.status}`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  return text.slice(-MAX_LOG_BYTES);
}

function failedSteps(job = {}) {
  return (job.steps || []).filter((step) =>
    ['failure', 'timed_out', 'cancelled'].includes(String(step.conclusion || '').toLowerCase())
  );
}

function importantLogLines(logText = '') {
  const lines = redactSecretLikeText(String(logText || '')).split(/\r?\n/);
  const indexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const errorLineRe =
      /(\bError\b|##\[error\]|failed|failure|exception|fatal|exit code|permission denied|403|did not include files)/i;
    if (errorLineRe.test(line)) {
      indexes.push(index);
    }
  }
  const selected = [];
  for (const index of indexes.slice(-3)) {
    for (let cursor = Math.max(0, index - 1); cursor <= Math.min(lines.length - 1, index + 1); cursor += 1) {
      const line = lines[cursor].trim();
      if (line && !selected.includes(line)) selected.push(line);
      if (selected.length >= MAX_EXCERPT_LINES) break;
    }
    if (selected.length >= MAX_EXCERPT_LINES) break;
  }
  if (!selected.length) {
    for (const line of lines.slice(-MAX_EXCERPT_LINES)) {
      const trimmed = line.trim();
      if (trimmed) selected.push(trimmed);
    }
  }
  return selected.map((line) => line.replace(/\s+/g, ' ').slice(0, 240));
}

function classifyGithubError(err) {
  if (err.status === 401 || err.status === 403) return { available: false, reason: 'permission_denied', error: err.message };
  if (err.status === 404) return { available: false, reason: 'not_found', error: err.message };
  return { available: false, reason: 'github_error', error: err.message };
}

export async function diagnoseGithubActionsForWorkItem(env = {}, item = {}, options = {}) {
  const config = githubActionsConfig(env);
  if (!config) return { available: false, reason: 'not_configured' };

  const fetchImpl = fetchImplFromEnv(env);
  try {
    const runs = await listWorkflowRuns(fetchImpl, config, item, options.events || []);
    const run = runs[0] || null;
    if (!run) return { available: false, reason: 'run_not_found' };

    const jobs = await listRunJobs(fetchImpl, config, run.id);
    const failed = jobs
      .filter((job) => ['failure', 'timed_out', 'cancelled'].includes(String(job.conclusion || '').toLowerCase()))
      .slice(0, MAX_FAILED_JOBS);
    const jobsToSummarize = failed.length ? failed : jobs.slice(0, 1);
    const summarizedJobs = [];

    for (const job of jobsToSummarize) {
      let logLines = [];
      let logError = null;
      if (job.id && ['failure', 'timed_out', 'cancelled'].includes(String(job.conclusion || '').toLowerCase())) {
        try {
          logLines = importantLogLines(await readJobLog(fetchImpl, config, job.id));
        } catch (err) {
          logError = err.status === 401 || err.status === 403 ? 'permission_denied' : err.message;
        }
      }
      summarizedJobs.push({
        id: job.id,
        name: job.name || `job ${job.id}`,
        status: job.status || null,
        conclusion: job.conclusion || null,
        url: job.html_url || null,
        failedStepName: failedSteps(job)[0]?.name || null,
        logLines,
        logError,
      });
    }

    return {
      available: true,
      workflowName: workflowDisplayName(run),
      workflowFile: workflowFileFromRun(run),
      runId: run.id,
      runNumber: run.run_number || null,
      runUrl: run.html_url || null,
      status: run.status || null,
      conclusion: run.conclusion || null,
      headBranch: run.head_branch || null,
      headSha: run.head_sha || null,
      jobs: summarizedJobs,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return classifyGithubError(err);
  }
}
