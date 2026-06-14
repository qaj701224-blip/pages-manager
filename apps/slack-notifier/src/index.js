import {
  addSlackReaction,
  notifySlackJob,
  notifySlackJobStatus,
  postSlackMessage,
  updateSlackMessage,
} from '@xd/slack-notifier-core';
import { jsonResponse } from '@xd/worker-kit';

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

function unauthorized(message) {
  return jsonResponse({ ok: false, error: message }, 401);
}

function misconfigured(message) {
  return jsonResponse({ ok: false, error: message }, 500);
}

function authorize(request, env = {}) {
  const expected = env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET;
  if (!expected) return misconfigured('Slack notifier shared secret is required');

  const actual = request.headers.get('X-Pages-Slack-Notifier-Token');
  if (actual !== expected) {
    return unauthorized('Invalid slack notifier token');
  }
  return null;
}

function transientStatusStore(existingMessage) {
  return {
    getSlackJobStatusMessage() {
      return existingMessage || null;
    },
    recordAgentRunEvent(input = {}) {
      return {
        created: true,
        event: {
          ...input,
          createdAt: new Date().toISOString(),
        },
      };
    },
    recordSlackJobStatusMessage(jobId, input = {}) {
      return {
        ...(existingMessage || {}),
        ...input,
        jobId,
      };
    },
  };
}

function transientMessageStore() {
  return {
    hasSlackNotification() {
      return false;
    },
    recordSlackNotification() {},
  };
}

export function createSlackNotifierApp() {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);

      try {
        if (request.method === 'GET' && url.pathname === '/health') {
          return jsonResponse({ status: 'ok', service: 'slack-notifier' });
        }

        if (!url.pathname.startsWith('/internal/slack-notifier/')) {
          return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
        }

        const authError = authorize(request, env);
        if (authError) return authError;

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/job-status') {
          const body = await readJson(request);
          const result = await notifySlackJobStatus(
            env,
            transientStatusStore(body.existingMessage || null),
            body.job,
            body.options || {}
          );
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/job-message') {
          const body = await readJson(request);
          const result = await notifySlackJob(env, transientMessageStore(), body.job, body.text, body.key);
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/message') {
          const body = await readJson(request);
          const result = await postSlackMessage(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/update') {
          const body = await readJson(request);
          const result = await updateSlackMessage(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        if (request.method === 'POST' && url.pathname === '/internal/slack-notifier/reaction') {
          const body = await readJson(request);
          const result = await addSlackReaction(env, body.payload || {});
          return jsonResponse(result || { ok: true, skipped: true, reason: 'no_target' });
        }

        return jsonResponse({ error: 'Endpoint not found', method: request.method, path: url.pathname }, 404);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message }, err.status || 500);
      }
    },
  };
}

const defaultApp = createSlackNotifierApp();

export default {
  fetch(request, env) {
    return defaultApp.fetch(request, env);
  },
};
