import http from 'node:http';

import { createGatewayApp } from './index.js';
import { MySqlGatewayStore } from './db/gateway-store.js';
import { runMigrations } from '../scripts/migrate.js';

async function createStoreFromEnv() {
  if (process.env.PAGES_STORE_BACKEND && process.env.PAGES_STORE_BACKEND !== 'mysql') {
    throw new Error('PAGES_STORE_BACKEND must be mysql');
  }

  if (process.env.PAGES_DB_AUTO_MIGRATE !== 'false') {
    await runMigrations(process.env);
  }

  return MySqlGatewayStore.create(process.env);
}

const store = await createStoreFromEnv();
const app = createGatewayApp({ store });
const port = Number(process.env.PORT || 8788);

const SESSION_ENV_KEYS = [
  'SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS',
  'SLACK_AGENT_ACTIVE_CONTEXT_TTL_DAYS',
  'SLACK_AGENT_WAITING_CLARIFICATION_TTL_DAYS',
  'SLACK_AGENT_RECENT_SESSION_DAYS',
  'SLACK_AGENT_ARCHIVE_AFTER_DAYS',
  'SLACK_AGENT_TURN_TIMEOUT_SECONDS',
  'SLACK_AGENT_SESSION_LEASE_SECONDS',
  'SLACK_AGENT_PROVIDER_THREAD_TTL_HOURS',
  'CODING_AGENT_RUN_TIMEOUT_MINUTES',
];

const MERGE_ANNOUNCEMENT_ENV_KEYS = [
  'MERGE_ANNOUNCEMENT_ENABLED',
  'MERGE_ANNOUNCEMENT_CHANNEL_ID',
  'MERGE_ANNOUNCEMENT_BASE_REFS',
  'MERGE_ANNOUNCEMENT_AGENT_ENABLED',
  'MERGE_ANNOUNCEMENT_INCLUDE_SITE_PRS',
  'MERGE_ANNOUNCEMENT_MENTION_USER_IDS',
];

function sessionEnv() {
  return Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, process.env[key]]).filter(([, value]) => value));
}

function selectedEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]).filter(([, value]) => value));
}

function gatewayEnv() {
  return {
    ...sessionEnv(),
    ...selectedEnv(MERGE_ANNOUNCEMENT_ENV_KEYS),
    NODE_ENV: process.env.NODE_ENV,
    INTERNAL_CALLBACK_TOKEN: process.env.INTERNAL_CALLBACK_TOKEN,
    INTERNAL_CALLBACK_TOKEN_REQUIRED: process.env.INTERNAL_CALLBACK_TOKEN_REQUIRED,
    PAGES_GATEWAY_API_TOKEN: process.env.PAGES_GATEWAY_API_TOKEN,
    PAGES_INTERNAL_API_TOKEN: process.env.PAGES_INTERNAL_API_TOKEN,
    PAGES_GATEWAY_API_TOKEN_REQUIRED: process.env.PAGES_GATEWAY_API_TOKEN_REQUIRED,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_SIGNATURE_REQUIRED: process.env.SLACK_SIGNATURE_REQUIRED,
    SLACK_EVENTS_PROCESSING_MODE: process.env.SLACK_EVENTS_PROCESSING_MODE,
    SLACK_REACTION_ON_RECEIVE: process.env.SLACK_REACTION_ON_RECEIVE,
    SLACK_WORKING_REACTION: process.env.SLACK_WORKING_REACTION,
    SLACK_DONE_REACTION: process.env.SLACK_DONE_REACTION,
    SLACK_FAILED_REACTION: process.env.SLACK_FAILED_REACTION,
    SLACK_AGENT_TURN_URL: process.env.SLACK_AGENT_TURN_URL,
    SLACK_AGENT_ANALYZE_URL: process.env.SLACK_AGENT_ANALYZE_URL,
    SLACK_AGENT_SHARED_SECRET: process.env.SLACK_AGENT_SHARED_SECRET,
    SLACK_NOTIFIER_URL: process.env.SLACK_NOTIFIER_URL,
    SLACK_NOTIFIER_SHARED_SECRET: process.env.SLACK_NOTIFIER_SHARED_SECRET,
    PAGES_SLACK_NOTIFIER_URL: process.env.PAGES_SLACK_NOTIFIER_URL,
    PAGES_SLACK_NOTIFIER_SHARED_SECRET: process.env.PAGES_SLACK_NOTIFIER_SHARED_SECRET,
    GITHUB_REPO: process.env.GITHUB_REPO,
    GITHUB_ENTERPRISE_API_BASE_URL: process.env.GITHUB_ENTERPRISE_API_BASE_URL,
    GITHUB_API_BASE_URL: process.env.GITHUB_API_BASE_URL,
    GITHUB_STATUS_TOKEN: process.env.GITHUB_STATUS_TOKEN,
    GITHUB_APP_INSTALLATION_TOKEN: process.env.GITHUB_APP_INSTALLATION_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_REVIEW_AGENT_ALLOWLIST: process.env.GITHUB_REVIEW_AGENT_ALLOWLIST,
    GITHUB_REVIEW_AGENT_LOGINS: process.env.GITHUB_REVIEW_AGENT_LOGINS,
    GITHUB_REVIEW_AGENT_TIMEOUT_SECONDS: process.env.GITHUB_REVIEW_AGENT_TIMEOUT_SECONDS,
    PAGES_WORKER_START_URL: process.env.PAGES_WORKER_START_URL,
    PAGES_WORKER_SHARED_SECRET: process.env.PAGES_WORKER_SHARED_SECRET,
    PAGES_PLATFORM_GATE_APPROVERS: process.env.PAGES_PLATFORM_GATE_APPROVERS,
    PAGES_PLATFORM_GATE_APPROVER_IDS: process.env.PAGES_PLATFORM_GATE_APPROVER_IDS,
  };
}

async function reconcileReviewGate() {
  const headers = {};
  if (process.env.INTERNAL_CALLBACK_TOKEN) {
    headers['X-Pages-Callback-Token'] = process.env.INTERNAL_CALLBACK_TOKEN;
  }

  const response = await app.fetch(
    new Request('http://pages-gateway.internal/internal/review-gate/reconcile', {
      method: 'POST',
      headers,
    }),
    gatewayEnv()
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok === false) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'review_gate_reconcile_failed',
        status: response.status,
        error: body?.error || response.statusText,
      })
    );
    return;
  }

  if (body?.reconciled > 0) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'review_gate_reconciled',
        checked: body.checked,
        reconciled: body.reconciled,
      })
    );
  }
}

const server = http.createServer(async (nodeRequest, nodeResponse) => {
  const origin = `http://${nodeRequest.headers.host || `localhost:${port}`}`;
  const chunks = [];

  for await (const chunk of nodeRequest) {
    chunks.push(chunk);
  }

  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(new URL(nodeRequest.url || '/', origin), {
    method: nodeRequest.method,
    headers: nodeRequest.headers,
    body,
  });

  const response = await app.fetch(request, gatewayEnv());

  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  console.log(`pages-gateway dev server listening on http://localhost:${port}`);
});

const reviewGateReconcileIntervalSeconds = Number(process.env.GITHUB_REVIEW_GATE_RECONCILE_INTERVAL_SECONDS || 0);
if (Number.isFinite(reviewGateReconcileIntervalSeconds) && reviewGateReconcileIntervalSeconds > 0) {
  const intervalMs = Math.max(5, reviewGateReconcileIntervalSeconds) * 1000;
  globalThis
    .setInterval(() => {
      reconcileReviewGate().catch((err) => {
        console.log(
          JSON.stringify({
            service: 'pages-gateway',
            message: 'review_gate_reconcile_error',
            error: err.message,
          })
        );
      });
    }, intervalMs)
    .unref?.();
}
