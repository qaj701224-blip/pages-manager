import http from 'node:http';

import { createWorkerApp } from './index.js';

const app = createWorkerApp();
const port = Number(process.env.PORT || 8790);

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

  const response = await app.fetch(request);
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  console.log(`pages-worker dev server listening on http://localhost:${port}`);
});
