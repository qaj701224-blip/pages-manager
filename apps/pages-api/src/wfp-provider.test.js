import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentProvider } from './wfp-provider.js';

test('WFP provider forwards exposure to upload and exposes OfficeNet helpers', async () => {
  const calls = [];
  const provider = createDeploymentProvider(
    {
      WFP_PROVIDER: {
        upload: async (input) => {
          calls.push(['upload', input]);
          return { scriptName: input.workerName };
        },
        removeOfficeNetBinding: async (input) => {
          calls.push(['removeOfficeNetBinding', input]);
          return { removed: true };
        },
        verifyOfficeNetAbsent: async (input) => {
          calls.push(['verifyOfficeNetAbsent', input]);
          return true;
        },
      },
    },
    { environment: 'production' }
  );

  await provider.upload({ workerName: 'worker_1', exposure: 'public' });
  assert.deepEqual(await provider.removeOfficeNetBinding({ workerName: 'worker_1' }), { removed: true });
  assert.equal(await provider.verifyOfficeNetAbsent({ workerName: 'worker_1' }), true);
  assert.equal(calls[0][0], 'upload');
  assert.equal(calls[0][1].exposure, 'public');
  assert.deepEqual(calls.slice(1), [
    ['removeOfficeNetBinding', { workerName: 'worker_1' }],
    ['verifyOfficeNetAbsent', { workerName: 'worker_1' }],
  ]);
});
