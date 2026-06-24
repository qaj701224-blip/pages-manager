import http from 'node:http';

import { createGatewayApp } from './index.js';
import { MySqlGatewayStore } from './db/gateway-store.js';
import { buildGatewayEnv } from './runtime-env.js';
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

function gatewayEnv() {
  return buildGatewayEnv(process.env);
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
