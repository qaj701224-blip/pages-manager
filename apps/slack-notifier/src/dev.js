import http from 'node:http';

import { createSlackNotifierApp } from './index.js';

const app = createSlackNotifierApp();
const port = Number(process.env.PORT || 8792);

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
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_API_URL: process.env.SLACK_API_URL,
    SLACK_POST_API_URL: process.env.SLACK_POST_API_URL,
    SLACK_UPDATE_API_URL: process.env.SLACK_UPDATE_API_URL,
    SLACK_API_BASE_URL: process.env.SLACK_API_BASE_URL,
    SLACK_NOTIFIER_SHARED_SECRET: process.env.SLACK_NOTIFIER_SHARED_SECRET,
  });

  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  console.log(`pages-slack-notifier dev server listening on http://localhost:${port}`);
});
