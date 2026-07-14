import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/put-pages-v2-secrets.sh');
const testSlackWebhookUrl = ['https://hooks.slack.com', 'services', 'T000', 'B000', 'PLACEHOLDER'].join('/');
const fixtureSecretPattern = new RegExp(
  [
    'cf-runtime-token',
    'hooks\\.slack\\.com',
    'site-secret-encryption-key',
    'webhook-url-encryption-key',
    'xds-openai-token',
    'active-pepper',
    'old-pepper',
    'fixture-s2s-shared-secret',
  ].join('|')
);

const baseEnv = {
  ...process.env,
  DRY_RUN: '1',
  CF_ACCOUNT_ID: 'cf-account',
  CF_API_TOKEN: 'cf-runtime-token',
  SLACK_PAGES_ALERT_WEBHOOK_URL: testSlackWebhookUrl,
  SITE_SECRET_ENCRYPTION_KEY: 'site-secret-encryption-key',
  WEBHOOK_URL_ENCRYPTION_KEY: 'webhook-url-encryption-key',
  XDS_OPENAI_TOKEN: 'xds-openai-token',
  ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_2026_06',
  ACCESS_KEY_PEPPERS: 'old:ACCESS_KEY_PEPPER_OLD,pepper_2026_06:ACCESS_KEY_PEPPER_202606',
  ACCESS_KEY_PEPPER_OLD: 'old-pepper',
  ACCESS_KEY_PEPPER_202606: 'active-pepper',
  S2S_CLIENT_KEYS: 'xdmaker:key_202607:S2S_SECRET_XDMAKER_202607',
  S2S_SECRET_XDMAKER_202607: 'fixture-s2s-shared-secret',
  SSO_CLIENT_SECRET: 'sso-client-secret',
  PAGES_SESSION_JWT_ACTIVE_KID: 'session-2026-06',
  PAGES_SESSION_JWT_KEYS: 'old:HS256:PAGES_SESSION_JWT_SECRET_OLD,session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606',
  PAGES_SESSION_JWT_SECRET_OLD: 'old-session-secret',
  PAGES_SESSION_JWT_SECRET_202606: 'active-session-secret',
  PAGES_CAP_JWT_ACTIVE_KID: 'cap-2026-06',
  PAGES_CAP_JWT_KEYS: 'old:HS256:PAGES_CAP_JWT_SECRET_OLD,cap-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
  PAGES_CAP_JWT_SECRET_OLD: 'old-cap-secret',
  PAGES_CAP_JWT_SECRET_202606: 'active-cap-secret',
};

function runScript(app, env = {}) {
  return spawnSync(scriptPath, [app], {
    cwd: repoRoot,
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
  });
}

test('pages-api secret injection includes WFP runtime secrets and access key peppers', () => {
  const result = runScript('apps/pages-api');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CF_ACCOUNT_ID/);
  assert.match(result.stdout, /CF_API_TOKEN/);
  assert.match(result.stdout, /SLACK_PAGES_ALERT_WEBHOOK_URL/);
  assert.match(result.stdout, /SITE_SECRET_ENCRYPTION_KEY/);
  assert.match(result.stdout, /WEBHOOK_URL_ENCRYPTION_KEY/);
  assert.match(result.stdout, /XDS_OPENAI_TOKEN/);
  assert.match(result.stdout, /ACCESS_KEY_PEPPER_OLD/);
  assert.match(result.stdout, /ACCESS_KEY_PEPPER_202606/);
  assert.match(result.stdout, /S2S_SECRET_XDMAKER_202607/);
  assert.doesNotMatch(result.stdout, fixtureSecretPattern);
});

test('pages-api secret injection rejects invalid S2S client key registries without printing secrets', () => {
  const cases = [
    ['empty registry', '   '],
    ['missing field', 'xdmaker:key_202607'],
    ['extra separator', 'xdmaker:key_202607:S2S_SECRET_XDMAKER_202607:'],
    ['unsafe client id', 'xd maker:key_202607:S2S_SECRET_XDMAKER_202607'],
    ['unsafe key id', 'xdmaker:key!:S2S_SECRET_XDMAKER_202607'],
    ['unsafe secret env name', 'xdmaker:key_202607:NOT_A_SECRET'],
    [
      'duplicate client and key',
      'xdmaker:key_202607:S2S_SECRET_XDMAKER_202607,xdmaker:key_202607:S2S_SECRET_XDMAKER_202607',
    ],
    [
      'more than two keys for one client',
      [
        'xdmaker:key_202607:S2S_SECRET_XDMAKER_202607',
        'xdmaker:key_202608:S2S_SECRET_XDMAKER_202608',
        'xdmaker:key_202609:S2S_SECRET_XDMAKER_202609',
      ].join(','),
    ],
  ];

  for (const [label, registry] of cases) {
    const result = runScript('apps/pages-api', { S2S_CLIENT_KEYS: registry });
    assert.notEqual(result.status, 0, label);
    assert.match(`${result.stderr}${result.stdout}`, /S2S_CLIENT_KEYS/, label);
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, /fixture-s2s-shared-secret/, label);
  }
});

test('pages-api secret injection requires every referenced S2S secret', () => {
  const result = runScript('apps/pages-api', {
    S2S_SECRET_XDMAKER_202607: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /S2S_SECRET_XDMAKER_202607/);
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /fixture-s2s-shared-secret/);
});

test('pages-api secret injection accepts runtime-safe S2S ids and injects shared references once', () => {
  const result = runScript('apps/pages-api', {
    S2S_CLIENT_KEYS:
      'xd.maker:key.202607:S2S_SECRET_XDMAKER_202607,xd.maker:key.202608:S2S_SECRET_XDMAKER_202607',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/S2S_SECRET_XDMAKER_202607/g) || []).length, 1);
  assert.doesNotMatch(result.stdout, /fixture-s2s-shared-secret/);
});

test('pages-auth secret injection includes SSO secret and session signing secrets', () => {
  const result = runScript('apps/pages-auth');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SSO_CLIENT_SECRET/);
  assert.match(result.stdout, /XDS_OPENAI_TOKEN/);
  assert.match(result.stdout, /PAGES_SESSION_JWT_SECRET_OLD/);
  assert.match(result.stdout, /PAGES_SESSION_JWT_SECRET_202606/);
  assert.doesNotMatch(result.stdout, /sso-client-secret|xds-openai-token|active-session-secret|old-session-secret/);
});

test('pages-router secret injection includes session signing and capability signing secrets', () => {
  const result = runScript('apps/pages-router');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_SESSION_JWT_SECRET_OLD/);
  assert.match(result.stdout, /PAGES_SESSION_JWT_SECRET_202606/);
  assert.match(result.stdout, /PAGES_CAP_JWT_SECRET_OLD/);
  assert.match(result.stdout, /PAGES_CAP_JWT_SECRET_202606/);
  assert.doesNotMatch(result.stdout, /SSO_CLIENT_SECRET|CF_API_TOKEN|active-session-secret|active-cap-secret/);
});

test('kv-gateway secret injection includes only capability signing secrets', () => {
  const result = runScript('apps/kv-gateway');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_CAP_JWT_SECRET_OLD/);
  assert.match(result.stdout, /PAGES_CAP_JWT_SECRET_202606/);
  assert.doesNotMatch(result.stdout, /SSO_CLIENT_SECRET|CF_API_TOKEN|PAGES_SESSION_JWT_SECRET|active-cap-secret/);
});

test('pages-console secret injection reuses session JWT signing secrets', () => {
  const result = runScript('apps/pages-console');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_SESSION_JWT_SECRET_OLD/);
  assert.match(result.stdout, /PAGES_SESSION_JWT_SECRET_202606/);
  assert.doesNotMatch(result.stdout, /CONSOLE_SESSION_SECRET|SSO_CLIENT_SECRET|CF_API_TOKEN|active-session-secret/);
});

test('pages-api secret injection fails when active pepper is missing from registry', () => {
  const result = runScript('apps/pages-api', {
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'missing',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ACCESS_KEY_ACTIVE_PEPPER_ID/);
  assert.doesNotMatch(result.stdout, /ACCESS_KEY_PEPPER_202606/);
});

test('pages-auth secret injection rejects unsupported session secret names', () => {
  const result = runScript('apps/pages-auth', {
    PAGES_SESSION_JWT_KEYS: 'session-2026-06:HS256:JWT_SECRET',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported session secret env var name/);
  assert.doesNotMatch(result.stdout, /JWT_SECRET/);
});

test('pages v2 secret injection rejects unsupported apps', () => {
  const result = runScript('apps/server');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported app/);
});
