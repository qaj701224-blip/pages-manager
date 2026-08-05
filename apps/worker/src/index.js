import { jsonResponse, timingSafeEqualString } from '@xd/worker-kit';

import { readWorkerConfig } from './config.js';
import { runWorkerForWorkItem } from './orchestrator.js';
import { sitePublishingRetiredResponse } from './retirement.js';

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function requireWorkerAuth(request, config) {
  if (!config.workerSharedSecret) {
    const error = new Error('Worker shared secret is not configured');
    error.status = 500;
    throw error;
  }

  const token = request.headers.get('X-Pages-Worker-Token');
  if (!timingSafeEqualString(token || '', config.workerSharedSecret)) {
    const error = new Error('Invalid worker token');
    error.status = 401;
    throw error;
  }
}

export function createWorkerApp(options = {}) {
  const config = options.config || readWorkerConfig();
  const adapters = options.adapters || {};

  return {
    async fetch(request) {
      const url = new URL(request.url);

      try {
        if (request.method === 'GET' && url.pathname === '/health') {
          return jsonResponse({ status: 'ok', service: 'pages-worker' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/publishing-jobs/start') {
          requireWorkerAuth(request, config);
          const body = await readJson(request);
          if ((body.workItemKind || body.work_item_kind) !== 'platform_dev') {
            return sitePublishingRetiredResponse();
          }
          const result = await runWorkerForWorkItem(body, config, adapters);
          return jsonResponse({ ok: true, result });
        }

        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      } catch (err) {
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}
