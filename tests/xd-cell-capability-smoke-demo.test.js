import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { executeCommand } from '../apps/pages-cli/src/commands.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(repoRoot, 'demos/xd-cell-capability-smoke');

test('xd-cell capability smoke demo dry-runs as worker with assets and safe runtime vars', async () => {
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
  assert.equal(body.site, 'xd-cell-capability-smoke');
  assert.equal(body.configPath, 'xd-cell.config.json');
  assert.equal(body.target.source, './src/worker.js');
  assert.equal(body.target.assets, './public');
  assert.equal(body.decision.deploymentShape, 'worker-with-assets');
  assert.equal(body.decision.requestedFallback, 'single-page-application');
  assert.equal(body.decision.resolvedFallback, 'index');
  assert.equal(body.decision.routingMode, 'worker-first');
  assert.deepEqual(body.runtime, {
    vars: ['API_BASE', 'DEMO_LABEL', 'FEATURE_FLAG'],
  });
  assert.equal(body.sideEffects.willDeploy, false);
  assert.ok(body.uploadPlanSummary.fileCount >= 4);
});

test('xd-cell capability smoke demo does not commit secret values', async () => {
  const config = await readFile(path.join(demoDir, 'xd-cell.config.json'), 'utf8');
  const worker = await readFile(path.join(demoDir, 'src/worker.js'), 'utf8');
  const readme = await readFile(path.join(demoDir, 'README.md'), 'utf8');
  const combined = `${config}\n${worker}\n${readme}`;

  assert.doesNotMatch(config, /API_TOKEN|SECRET|PASSWORD|PRIVATE_KEY/i);
  assert.doesNotMatch(combined, /xdpak_|cf_secret|super-secret|real token/i);
  assert.match(worker, /hasApiToken/);
  assert.doesNotMatch(worker, /apiToken(?:Value|Length)?\s*:\s*env\.API_TOKEN/);
  assert.doesNotMatch(worker, /secret(?:Value)?\s*:\s*env\.API_TOKEN/);
});
