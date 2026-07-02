import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/put-pages-v2-secrets.sh');
const testSlackWebhookUrl = ['https://hooks.slack.com', 'services', 'T000', 'B000', 'PLACEHOLDER'].join('/');

const baseEnv = {
  ...process.env,
  DRY_RUN: '1',
  CF_ACCOUNT_ID: 'cf-account',
  CF_API_TOKEN: 'cf-runtime-token',
  SLACK_PAGES_ALERT_WEBHOOK_URL: testSlackWebhookUrl,
  SITE_SECRET_ENCRYPTION_KEY: 'site-secret-encryption-key',
  XDS_OPENAI_TOKEN: 'xds-openai-token',
  ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_2026_06',
  ACCESS_KEY_PEPPERS: 'old:ACCESS_KEY_PEPPER_OLD,pepper_2026_06:ACCESS_KEY_PEPPER_202606',
  ACCESS_KEY_PEPPER_OLD: 'old-pepper',
  ACCESS_KEY_PEPPER_202606: 'active-pepper',
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
  assert.match(result.stdout, /XDS_OPENAI_TOKEN/);
  assert.match(result.stdout, /ACCESS_KEY_PEPPER_OLD/);
  assert.match(result.stdout, /ACCESS_KEY_PEPPER_202606/);
  assert.doesNotMatch(
    result.stdout,
    /cf-runtime-token|hooks\.slack\.com|site-secret-encryption-key|xds-openai-token|active-pepper|old-pepper/
  );
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
