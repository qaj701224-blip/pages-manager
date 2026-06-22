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

function normalizePublishingJobInput(body, request) {
  const actor = actorFromHeaders(request, body);
  const idempotencyKey = request.headers.get('Idempotency-Key') || body.idempotencyKey || body.idempotency_key || body.requestId;

  return {
    source: body.source || 'api',
    requestedByType: actor.requestedByType,
    requestedById: required(actor.requestedById, 'requestedById'),
    idempotencyKey: required(idempotencyKey, 'idempotencyKey'),
    employeeSlug: required(body.employeeSlug || body.employee_slug, 'employeeSlug'),
    siteSlug: required(body.siteSlug || body.site_slug, 'siteSlug'),
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
  const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;

  return jsonResponse({ job, created, ...(workerStart ? { workerStart } : {}) }, created ? 201 : 200);
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
