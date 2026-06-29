const CODING_FIX_DISPATCHED_EVENT = 'coding_fix_dispatched';

function shouldStartWorkerForJob(job) {
  if (!job) return false;
  return job.status === 'received' || job.status === 'generating_page' || job.status === 'fixing' || job.status === 'previewing';
}

function shouldStartWorkerForPlatformDevItem(item = {}) {
  if (item.status === 'received') return true;
  if (!item.agentEligible) return false;
  if (item.autoDevStatus !== 'triggered') return false;
  return ['issue_created', 'agent_queued'].includes(item.status);
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function followupRoundFromSummary(summary = '') {
  return (String(summary || '').match(/## Slack Follow-up/g) || []).length;
}

async function postWorkerStart(fetchImpl, url, payload, headers) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await readResponseJson(response);

    if (!response.ok || body?.ok === false) {
      return {
        started: false,
        error: body?.error || response.statusText || `HTTP ${response.status}`,
      };
    }

    return {
      started: true,
      response: body,
    };
  } catch (error) {
    return {
      started: false,
      error: error?.message || 'Worker start failed',
    };
  }
}

async function recordCodingFixDispatch(store, job, workerStart) {
  if (!workerStart?.started || !store?.recordAgentRunEvent || job?.status !== 'fixing') return null;

  const round = followupRoundFromSummary(job.summary);
  return await store.recordAgentRunEvent({
    publishingJobId: job.id,
    slackSessionId: job.slackSessionId || null,
    type: CODING_FIX_DISPATCHED_EVENT,
    stage: 'fixing',
    status: 'dispatched',
    text: `round:${Math.max(1, Number(round) || 1)} Coding Agent 修复已启动。`,
    dedupeKey: `coding-fix-dispatched:${job.id}:${job.updatedAt || Date.now()}:${Math.max(1, Number(round) || 1)}`,
  });
}

export async function startWorkerForJobIfConfigured(job, env) {
  if (!env.PAGES_WORKER_START_URL || !shouldStartWorkerForJob(job)) return null;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (env.PAGES_WORKER_SHARED_SECRET) {
    headers['X-Pages-Worker-Token'] = env.PAGES_WORKER_SHARED_SECRET;
  }

  const fetchImpl = env.WORKER_FETCH || fetch;
  const result = await postWorkerStart(fetchImpl, env.PAGES_WORKER_START_URL, { job }, headers);
  const store = env.store || env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  if (job.status === 'fixing' && store) {
    result.dispatchEvent = await recordCodingFixDispatch(store, job, result);
  }

  return result;
}

export async function startWorkerForPlatformDevItemIfConfigured(item, env) {
  if (!env.PAGES_WORKER_START_URL || !shouldStartWorkerForPlatformDevItem(item)) return null;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (env.PAGES_WORKER_SHARED_SECRET) {
    headers['X-Pages-Worker-Token'] = env.PAGES_WORKER_SHARED_SECRET;
  }

  const fetchImpl = env.WORKER_FETCH || fetch;
  return await postWorkerStart(
    fetchImpl,
    env.PAGES_WORKER_START_URL,
    { workItemKind: 'platform_dev', platformDevItem: item },
    headers
  );
}
