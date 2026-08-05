import assert from 'node:assert/strict';
import test from 'node:test';

import { SITE_PUBLISHING_RETIRED_CODE, SITE_PUBLISHING_RETIRED_MESSAGE, sitePublishingRetiredResponse } from './retirement.js';

test('site publishing retirement protocol is static and actionable', async () => {
  assert.equal(SITE_PUBLISHING_RETIRED_CODE, 'PUBLISHING_LANE_RETIRED');
  assert.equal(SITE_PUBLISHING_RETIRED_MESSAGE, '站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。');

  const response = sitePublishingRetiredResponse();
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: 'PUBLISHING_LANE_RETIRED',
    message: '站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。',
  });
});
