import http from 'node:http';

import { createGatewayApp } from './index.js';

const app = createGatewayApp();
const port = Number(process.env.PORT || 8788);

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
    INTERNAL_CALLBACK_TOKEN: process.env.INTERNAL_CALLBACK_TOKEN,
    SLACK_CONNECTOR_SHARED_SECRET: process.env.SLACK_CONNECTOR_SHARED_SECRET,
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
