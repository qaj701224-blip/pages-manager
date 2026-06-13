import http from 'node:http';

import { FileBackedGatewayStore } from './file-store.js';
import { createGatewayApp } from './index.js';

const store = process.env.PAGES_GATEWAY_STORE_FILE ? new FileBackedGatewayStore(process.env.PAGES_GATEWAY_STORE_FILE) : undefined;
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

function sessionEnv() {
  return Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, process.env[key]]).filter(([, value]) => value));
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

  const response = await app.fetch(request, {
    ...sessionEnv(),
    INTERNAL_CALLBACK_TOKEN: process.env.INTERNAL_CALLBACK_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_SIGNATURE_REQUIRED: process.env.SLACK_SIGNATURE_REQUIRED,
    SLACK_EVENTS_PROCESSING_MODE: process.env.SLACK_EVENTS_PROCESSING_MODE,
    SLACK_REACTION_ON_RECEIVE: process.env.SLACK_REACTION_ON_RECEIVE,
    SLACK_WORKING_REACTION: process.env.SLACK_WORKING_REACTION,
    SLACK_AGENT_ANALYZE_URL: process.env.SLACK_AGENT_ANALYZE_URL,
    SLACK_AGENT_SHARED_SECRET: process.env.SLACK_AGENT_SHARED_SECRET,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_API_URL: process.env.SLACK_API_URL,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_REVIEW_AGENT_ALLOWLIST: process.env.GITHUB_REVIEW_AGENT_ALLOWLIST,
    GITHUB_REVIEW_AGENT_LOGINS: process.env.GITHUB_REVIEW_AGENT_LOGINS,
    PAGES_WORKER_START_URL: process.env.PAGES_WORKER_START_URL,
    PAGES_WORKER_SHARED_SECRET: process.env.PAGES_WORKER_SHARED_SECRET,
  });

  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  console.log(`pages-gateway dev server listening on http://localhost:${port}`);
});
