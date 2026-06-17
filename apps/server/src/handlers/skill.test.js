import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPublicConfig } from '../lib/public-config.js';
import { renderSkill } from './skill.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

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

test('skill public output says v1 Pages KV is retired without SDK usage', () => {
  const skill = readFileSync(join(repoRoot, 'pages-deploy.skill.md'), 'utf8');
  const rendered = renderSkill(skill, getPublicConfig(new Request('https://api.workers.xd.team/skill.md'), {}));

  assert.match(rendered, /v1 不再提供 Pages KV|Pages KV 已迁入 v2/);
  assert.doesNotMatch(rendered, /@xd\/pages-sdk\/browser/);
  assert.doesNotMatch(rendered, /@xd\/pages-sdk\/worker/);
  assert.doesNotMatch(rendered, /\/\.xd-pages\/runtime\/v1/);
  assert.doesNotMatch(rendered, /前缀隔离|prefix isolation/);
  assert.doesNotMatch(rendered, /高度敏感|highly sensitive/);

  assert.doesNotMatch(rendered, /PAGES_CAP_JWT_SECRET/);
  assert.doesNotMatch(rendered, /SITE_DATA_KV_NAMESPACE_ID/);
  assert.doesNotMatch(rendered, /capability\.jwt/);
});
