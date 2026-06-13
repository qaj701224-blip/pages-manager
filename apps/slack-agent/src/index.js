import { jsonResponse } from '@xd/worker-kit';

import { analyzeSlackRequirementDeterministic } from './analysis.js';
import { readSlackAgentConfig } from './config.js';
import { analyzeSlackRequirementWithProvider } from './model-provider.js';

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

function requireAgentAuth(request, config) {
  if (!config.sharedSecret) return;

  const token = request.headers.get('X-Pages-Slack-Agent-Token');
  if (token !== config.sharedSecret) {
    const error = new Error('Invalid Slack agent token');
    error.status = 401;
    throw error;
  }
}

export function analyzeSlackRequirement(input = {}) {
  return analyzeSlackRequirementDeterministic(input);
}

export function createSlackAgentApp(options = {}) {
  const config = options.config || readSlackAgentConfig();
  const fetchImpl = options.fetchImpl || options.fetch || fetch;

  return {
    async fetch(request) {
      const url = new URL(request.url);

      try {
        if (request.method === 'GET' && url.pathname === '/health') {
          return jsonResponse({
            status: 'ok',
            service: 'pages-slack-agent',
            modelProvider: config.modelProvider,
            modelName: config.modelName,
          });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-agent/analyze') {
          requireAgentAuth(request, config);
          const body = await readJson(request);
          const analysis = await analyzeSlackRequirementWithProvider(body, { config, fetchImpl });
          return jsonResponse({ ok: true, analysis });
        }

        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      } catch (err) {
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}
