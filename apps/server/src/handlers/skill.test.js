import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicConfig } from '../lib/public-config.js';
import { renderSkill } from './skill.js';

test('renderSkill rewrites production defaults for staging', () => {
  const config = getPublicConfig(new Request('https://api-staging.workers.xd.team/skill.md'), {
    DOMAIN_BASE: 'workers.xd.team',
    DOMAIN_LABEL: '-staging',
    WORKER_PREFIX: 'pages-staging-',
    WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
    PAGES_MANAGER_WORKER_NAME: 'pages-manager-staging',
    PUBLIC_API_BASE: 'https://api-staging.workers.xd.team',
    PUBLIC_ENVIRONMENT: 'staging',
  });
  const template = [
    'curl -s https://pages-manager.xd-cf-2022.workers.dev/openapi.json',
    '备用地址：https://api.workers.xd.team/openapi.json',
    '发布到 `{name}.workers.xd.team`。',
  ].join('\n');

  const rendered = renderSkill(template, config);

  assert.match(rendered, /https:\/\/pages-manager-staging\.xd-cf-2022\.workers\.dev\/openapi\.json/);
  assert.match(rendered, /https:\/\/api-staging\.workers\.xd\.team\/openapi\.json/);
  assert.match(rendered, /`{name}-staging\.workers\.xd\.team`/);
  assert.doesNotMatch(rendered, /https:\/\/api\.workers\.xd\.team/);
});
