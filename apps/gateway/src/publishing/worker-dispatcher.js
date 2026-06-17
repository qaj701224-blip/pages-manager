const CODING_FIX_DISPATCHED_EVENT = 'coding_fix_dispatched';

function shouldStartWorkerForJob(job) {
  return job.status === 'received' || job.status === 'generating_page' || job.status === 'fixing' || job.status === 'previewing';
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
  const response = await fetchImpl(env.PAGES_WORKER_START_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ job }),
  });
  const body = await readResponseJson(response);

  if (!response.ok || body?.ok === false) {
    return {
      started: false,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  const result = {
    started: true,
    response: body,
  };
  const store = env.store || env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  if (job.status === 'fixing' && store) {
    result.dispatchEvent = await recordCodingFixDispatch(store, job, result);
  }

  return result;
}
