import { jsonResponse } from '@xd/worker-kit';

import { readJson } from '../http/body.js';
import { getStore, required, verifyGatewayApiToken } from '../control-plane/context.js';
import { startWorkerForJobIfConfigured } from './worker-dispatcher.js';

function actorFromHeaders(request, fallback = {}) {
  return {
    requestedByType: request.headers.get('X-Pages-Actor-Type') || fallback.requestedByType || 'user',
    requestedById: request.headers.get('X-Pages-Actor-Id') || fallback.requestedById,
  };
}

function validateSlug(value, name, maxLength) {
  const slug = String(required(value, name)).trim();
  const valid =
    slug.length <= maxLength &&
    /^[a-z0-9]$/.test(slug[0] || '') &&
    /^[a-z0-9]$/.test(slug.at(-1) || '') &&
    /^[a-z0-9-]+$/.test(slug);
  if (!valid) {
    const error = new Error(`${name} must use lowercase letters, numbers, and hyphens only`);
    error.status = 400;
    throw error;
  }
  return slug;
}

function normalizePublishingJobInput(body, request) {
  const actor = actorFromHeaders(request, body);
  const idempotencyKey = request.headers.get('Idempotency-Key') || body.idempotencyKey || body.idempotency_key || body.requestId;
  const employeeSlug = validateSlug(body.employeeSlug || body.employee_slug, 'employeeSlug', 80);
  const siteSlug = validateSlug(body.siteSlug || body.site_slug, 'siteSlug', 120);

  return {
    source: body.source || 'api',
    requestedByType: actor.requestedByType,
    requestedById: required(actor.requestedById, 'requestedById'),
    idempotencyKey: required(idempotencyKey, 'idempotencyKey'),
    employeeSlug,
    siteSlug,
    siteProjectId: body.siteProjectId || body.site_project_id || null,
    ownerScopeId: body.ownerScopeId || body.owner_scope_id || null,
    employeeId: body.employeeId || body.employee_id || null,
    intent: body.intent || 'create_site',
    approvalMode: body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title,
    summary: body.summary || body.brief || '',
    brief: body.brief,
    requesterProfile: body.requesterProfile || body.requester_profile || null,
  };
}

export async function handleCreatePublishingJob(request, env) {
  const authError = verifyGatewayApiToken(request, env);
  if (authError) return authError;

  const store = getStore(env);
  const body = await readJson(request);
  const { job, created } = await store.createJob(normalizePublishingJobInput(body, request));
  let workerStart = null;
  let responseJob = job;
  if (created) {
    try {
      workerStart = await startWorkerForJobIfConfigured(job, env);
    } catch (error) {
      workerStart = { started: false, error: error.message || 'Worker start failed' };
    }
    if (workerStart?.started === false) {
      responseJob = await store.failJob?.(job.id, 'worker_start_failed', workerStart.error || 'Worker start failed');
      return jsonResponse({ job: responseJob || job, created, workerStart }, 502);
    }
  }

  return jsonResponse({ job: responseJob, created, ...(workerStart ? { workerStart } : {}) }, created ? 201 : 200);
}

export async function handleListPublishingJobs(request, env) {
  const authError = verifyGatewayApiToken(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const result = await getStore(env).listJobs({
    status: url.searchParams.get('status') || undefined,
    source: url.searchParams.get('source') || undefined,
    q: url.searchParams.get('q') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  });

  return jsonResponse(result);
}

export async function handleGetPublishingJob(request, env, params) {
  const authError = verifyGatewayApiToken(request, env);
  if (authError) return authError;

  const job = await getStore(env).getJob(params.jobId);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ job });
}

export async function handleGetPublishingJobEvents(request, env, params) {
  const authError = verifyGatewayApiToken(request, env);
  if (authError) return authError;

  const store = getStore(env);
  if (!(await store.getJob(params.jobId))) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ events: await store.listEvents(params.jobId) });
}
