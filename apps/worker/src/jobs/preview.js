import {
  allowedPathForJob,
  buildPagesPreviewInputs,
  dispatchWorkflow,
  githubApiUrl,
  githubRequest,
  parseRepoFullName,
} from '@xd/git-client';

import { postExecutorCallback } from '../integrations/gateway-client.js';

function previewHostnameForJob(job, config) {
  if (!config.previewHostnamePattern) return '';
  return config.previewHostnamePattern
    .replaceAll('{prNumber}', String(job.prNumber || ''))
    .replaceAll('{employeeSlug}', job.employeeSlug || '')
    .replaceAll('{siteSlug}', job.siteSlug || '')
    .replaceAll('{publishingJobId}', job.id || '');
}

function safePreviewSiteName(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = normalized.slice(0, 50).replace(/-+$/g, '');
  if (trimmed.length >= 2) return trimmed;
  return `pm-${trimmed || 'preview'}`.slice(0, 50).replace(/-+$/g, '');
}

function previewSiteNameForJob(job, config) {
  const pattern = config.previewSiteNamePattern || 'pm-pr-{prNumber}-{employeeSlug}-{siteSlug}';
  return safePreviewSiteName(
    pattern
      .replaceAll('{prNumber}', String(job.prNumber || ''))
      .replaceAll('{employeeSlug}', job.employeeSlug || '')
      .replaceAll('{siteSlug}', job.siteSlug || '')
      .replaceAll('{publishingJobId}', job.id || '')
  );
}

function previewTokenForJob(job, config) {
  if (!config.previewTokenPattern) return config.pagesToken || '';

  return config.previewTokenPattern
    .replaceAll('{prNumber}', String(job.prNumber || ''))
    .replaceAll('{employeeSlug}', job.employeeSlug || '')
    .replaceAll('{siteSlug}', job.siteSlug || '')
    .replaceAll('{publishingJobId}', job.id || '');
}

function pagesApiDeployUrl(config) {
  return `${String(config.pagesApi || 'https://api-staging.workers.xd.team').replace(/\/+$/, '')}/deploy`;
}

async function githubTreeFiles(fetchImpl, github, headSha) {
  const { owner, repo } = parseRepoFullName(github.repoFullName);
  const result = await githubRequest(fetchImpl, github, {
    url: githubApiUrl(github, `/repos/${owner}/${repo}/git/trees/${headSha}`, { recursive: 1 }),
  });
  return (result.body?.tree || [])
    .filter((item) => item.type === 'blob')
    .sort((a, b) => a.path.localeCompare(b.path));
}

function previewFilesFromTree(tree, allowedPath) {
  const sourcePrefix = `${allowedPath}/src/`;
  const files = tree.filter((item) => item.path?.startsWith(sourcePrefix));
  return { files, sourcePrefix };
}

async function githubBlobBytes(fetchImpl, github, sha) {
  const { owner, repo } = parseRepoFullName(github.repoFullName);
  const result = await githubRequest(fetchImpl, github, {
    url: githubApiUrl(github, `/repos/${owner}/${repo}/git/blobs/${sha}`),
  });
  const body = result.body || {};
  if (body.encoding !== 'base64') {
    throw new Error(`Unsupported GitHub blob encoding: ${body.encoding || 'unknown'}`);
  }
  return Buffer.from(String(body.content || '').replaceAll(/\s+/g, ''), 'base64');
}

async function deployPreviewLocally(job, config, adapters = {}) {
  const pagesToken = previewTokenForJob(job, config);
  if (!pagesToken) {
    throw new Error('PAGES_PREVIEW_TOKEN_PATTERN, PAGES_PREVIEW_TOKEN, or PAGES_TOKEN is required for local preview deploy');
  }

  const fetchImpl = adapters.fetchImpl || fetch;
  const callback = adapters.postExecutorCallback || postExecutorCallback;
  const github = config.github;
  const allowedPath = allowedPathForJob(job);
  const tree = await githubTreeFiles(fetchImpl, github, job.headSha);
  const { files, sourcePrefix } = previewFilesFromTree(tree, allowedPath);

  if (!files.length) {
    throw new Error(`No preview files found under ${allowedPath}/src/`);
  }

  const form = new FormData();
  const previewSiteName = previewSiteNameForJob(job, config);
  form.set('name', previewSiteName);
  form.set('preset', 'static');
  form.set('ip_restrict', config.previewIpRestrict ? 'true' : 'false');

  let index = 0;
  for (const file of files) {
    const bytes = await githubBlobBytes(fetchImpl, github, file.sha);
    const relativePath = file.path.slice(sourcePrefix.length);
    form.append(`file-${index}`, new Blob([bytes]), relativePath);
    index += 1;
  }

  const response = await fetchImpl(pagesApiDeployUrl(config), {
    method: 'POST',
    headers: {
      'X-Pages-Token': pagesToken,
    },
    body: form,
  });
  const deployResult = await response.json().catch(() => null);
  if (!response.ok || !deployResult?.url) {
    throw new Error(deployResult?.error || response.statusText || `Preview deploy failed with HTTP ${response.status}`);
  }

  await callback(fetchImpl, config, {
    publishingJobId: job.id,
    executorType: 'pages_worker',
    status: 'succeeded',
    stageResult: 'preview_deployed',
    previewUrl: deployResult.url,
    deployId: deployResult.name || previewSiteName,
    prNumber: job.prNumber,
    headSha: job.headSha,
  });

  return {
    action: 'pages_preview_deployed',
    previewUrl: deployResult.url,
    deployResult,
  };
}

export async function startPagesPreview(job, config, adapters = {}) {
  if (!job.prNumber) throw new Error('job.prNumber is required for preview');
  if (!job.headSha) throw new Error('job.headSha is required for preview');

  if (config.previewMode === 'local_deploy') {
    return deployPreviewLocally(job, config, adapters);
  }

  const fetchImpl = adapters.fetchImpl || fetch;
  const github = config.github;

  const workflow = await dispatchWorkflow(fetchImpl, github, {
    workflowId: 'pages-preview.yml',
    ref: config.workflowRef,
    inputs: buildPagesPreviewInputs(job, {
      callbackUrl: config.callbackUrl,
      previewHostname: previewHostnameForJob(job, config),
      previewSiteName: previewSiteNameForJob(job, config),
    }),
  });

  return {
    action: 'pages_preview_dispatched',
    workflow,
  };
}
