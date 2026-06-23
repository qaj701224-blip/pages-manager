import { jsonResponse } from '@xd/worker-kit';

import { analyzeSlackRequirementDeterministic, buildSlackAgentTurn } from './analysis.js';
import { readSlackAgentConfig } from './config.js';
import {
  answerRepoQuestionWithProvider,
  analyzeSlackRequirementWithProvider,
  streamSlackAgentTurnEvents,
  summarizeMergeAnnouncementWithProvider,
} from './model-provider.js';

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
  if (!config.sharedSecret) {
    const error = new Error('Slack agent shared secret is not configured');
    error.status = 500;
    throw error;
  }

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

export async function runSlackAgentTurn(input = {}, options = {}) {
  const analysis = await analyzeSlackRequirementWithProvider(input, options);
  return buildSlackAgentTurn(input, analysis);
}

function wantsNdjson(request) {
  return /\bapplication\/x-ndjson\b/i.test(request.headers.get('Accept') || '');
}

function ndjsonStreamResponse(events) {
  const encoder = new globalThis.TextEncoder();
  return new Response(
    new globalThis.ReadableStream({
      async start(controller) {
        try {
          for await (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    }
  );
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

        if (request.method === 'POST' && url.pathname === '/internal/slack-agent/turn') {
          requireAgentAuth(request, config);
          const body = await readJson(request);
          if (wantsNdjson(request)) {
            return ndjsonStreamResponse(streamSlackAgentTurnEvents(body, { config, fetchImpl }));
          }
          const turn = await runSlackAgentTurn(body, { config, fetchImpl });
          return jsonResponse({ ok: true, turn, analysis: turn.analysis });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-agent/merge-summary') {
          requireAgentAuth(request, config);
          const body = await readJson(request);
          const summary = await summarizeMergeAnnouncementWithProvider(body, { config, fetchImpl });
          return jsonResponse({ ok: true, summary });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-agent/repo-answer') {
          requireAgentAuth(request, config);
          const body = await readJson(request);
          const answer = await answerRepoQuestionWithProvider(body, { config, fetchImpl });
          return jsonResponse({ ok: true, answer });
        }

        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      } catch (err) {
        return jsonResponse({ error: err.message }, err.status || 500);
      }
    },
  };
}
