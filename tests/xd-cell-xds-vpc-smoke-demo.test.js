import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { executeCommand } from '../apps/pages-cli/src/commands.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(repoRoot, 'demos/xd-cell-xds-vpc-smoke');

test('xd-cell XDS VPC smoke demo dry-runs as worker with assets and safe runtime vars', async () => {
  const output = [];

  const exitCode = await executeCommand(['deploy', '--dry-run', '--json'], {
    cwd: demoDir,
    secretStore: {
      get: async () => {
        throw new Error('demo dry-run should not read local credentials');
      },
    },
    fetch: async () => {
      throw new Error('demo dry-run should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.site, 'xd-cell-xds-vpc-smoke');
  assert.equal(body.target.source, './src/worker.js');
  assert.equal(body.target.assets, './public');
  assert.equal(body.decision.deploymentShape, 'worker-with-assets');
  assert.equal(body.decision.routingMode, 'worker-first');
  assert.deepEqual(body.runtime, {
    vars: ['XDS_SEARCH_KEYWORD'],
  });
});

test('xd-cell XDS VPC smoke worker signs XDS search requests through VPC binding without exposing secrets', async () => {
  const { default: worker } = await import(pathToFileURL(path.join(demoDir, 'src/worker.js')).href);
  const calls = [];
  const env = {
    XDS_OPENAI_TOKEN: 'secret-token',
    XDS_SEARCH_KEYWORD: '平台支撑部',
    XD_OFFICE_NET: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({
          code: 0,
          data: {
            list: [
              {
                email: 'user@xd.com',
                realname: '示例用户',
                departmentPath: '心动/发行服务/平台支撑部',
              },
            ],
          },
        });
      },
    },
    ASSETS: {
      fetch: async () => new Response('asset'),
    },
  };

  const response = await worker.fetch(new Request('https://demo.example/api/xds-search'), env);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.secret.secretPresent, true);
  assert.equal(JSON.stringify(body).includes('secret-token'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://xds.xindong.com/xds-open-api/v1/oa-user/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['x-ts'].length > 0, true);
  assert.equal(calls[0].init.headers['x-nonce'].length > 0, true);
  assert.match(calls[0].init.headers['x-sign'], /^[a-f0-9]{40}$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { keyword: '平台支撑部' });
  assert.deepEqual(body.xds, {
    endpoint: '/xds-open-api/v1/oa-user/search',
    status: 200,
    code: 0,
    itemCount: 1,
    sampleKeys: ['departmentPath', 'email', 'realname'],
  });
});

test('xd-cell XDS VPC smoke demo does not commit secret values', async () => {
  const config = await readFile(path.join(demoDir, 'xd-cell.config.json'), 'utf8');
  const workerSource = await readFile(path.join(demoDir, 'src/worker.js'), 'utf8');
  const readme = await readFile(path.join(demoDir, 'README.md'), 'utf8');
  const combined = `${config}\n${workerSource}\n${readme}`;

  assert.doesNotMatch(config, /XDS_OPENAI_TOKEN|SECRET|PASSWORD|PRIVATE_KEY/i);
  assert.doesNotMatch(combined, /xdpak_|cf_secret|super-secret|real token/i);
  assert.doesNotMatch(combined, /XDS_OPENAI_TOKEN\\s*[:=]\\s*['"][^'"]+['"]/);
  assert.doesNotMatch(workerSource, /token(?:Value|Length)?\s*:\s*env\.XDS_OPENAI_TOKEN/);
});
