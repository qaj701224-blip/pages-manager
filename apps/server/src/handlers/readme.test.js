import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicConfig } from '../lib/public-config.js';
import { handleReadme, renderReadme } from './readme.js';

test('renderReadme rewrites production defaults for staging', () => {
  const config = getPublicConfig(new Request('https://api-staging.workers.xd.team/readme.md'), {
    DOMAIN_BASE: 'workers.xd.team',
    DOMAIN_LABEL: '-staging',
    WORKER_PREFIX: 'pages-staging-',
    WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
    PAGES_MANAGER_WORKER_NAME: 'pages-manager-staging',
    PUBLIC_API_BASE: 'https://api-staging.workers.xd.team',
    PUBLIC_ENVIRONMENT: 'staging',
  });
  const template = [
    'API: https://api.workers.xd.team',
    'Site: https://q2-report.workers.xd.team',
    'Dev: https://pages-q2-report.xd-cf-2022.workers.dev',
  ].join('\n');

  const rendered = renderReadme(template, config);

  assert.match(rendered, /https:\/\/api-staging\.workers\.xd\.team/);
  assert.match(rendered, /https:\/\/q2-report-staging\.workers\.xd\.team/);
  assert.match(rendered, /https:\/\/pages-staging-q2-report\.xd-cf-2022\.workers\.dev/);
  assert.doesNotMatch(rendered, /https:\/\/api\.workers\.xd\.team/);
  assert.doesNotMatch(rendered, /https:\/\/q2-report\.workers\.xd\.team/);
});

test('handleReadme returns environment-aware markdown without cache', async () => {
  const response = handleReadme(
    'API: https://api.workers.xd.team\nSite: https://q2-report.workers.xd.team',
    new Request('https://api-staging.workers.xd.team/readme.md'),
    {
      DOMAIN_BASE: 'workers.xd.team',
      DOMAIN_LABEL: '-staging',
      WORKER_PREFIX: 'pages-staging-',
      WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
      PAGES_MANAGER_WORKER_NAME: 'pages-manager-staging',
      PUBLIC_API_BASE: 'https://api-staging.workers.xd.team',
      PUBLIC_ENVIRONMENT: 'staging',
    }
  );

  const text = await response.text();
  assert.equal(response.headers.get('Content-Type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(text, /https:\/\/api-staging\.workers\.xd\.team/);
  assert.match(text, /https:\/\/q2-report-staging\.workers\.xd\.team/);
  assert.doesNotMatch(text, /https:\/\/api\.workers\.xd\.team/);
});

test('renderReadme rewrites README infrastructure table for staging', () => {
  const config = getPublicConfig(new Request('https://api-staging.workers.xd.team/readme.md'), {
    DOMAIN_BASE: 'workers.xd.team',
    DOMAIN_LABEL: '-staging',
    WORKER_PREFIX: 'pages-staging-',
    WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
    PAGES_MANAGER_WORKER_NAME: 'pages-manager-staging',
    PUBLIC_API_BASE: 'https://api-staging.workers.xd.team',
    PUBLIC_ENVIRONMENT: 'staging',
  });
  const template = '| 管理 Worker  | `pages-manager`，绑定 `api.workers.xd.team`             |';

  const rendered = renderReadme(template, config);

  assert.match(rendered, /`pages-manager-staging`，绑定 `api-staging\.workers\.xd\.team`/);
  assert.doesNotMatch(rendered, /`pages-manager`，绑定 `api\.workers\.xd\.team`/);
});
