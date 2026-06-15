import assert from 'node:assert/strict';
import test from 'node:test';

import { loginWithAccessKey, loginWithBrowser } from './login.js';

const productionConfig = {
  environment: 'production',
  apiBaseUrl: 'https://api.pages.xd.team',
  authBaseUrl: 'https://auth.pages.xd.team',
  siteDomainSuffix: 'pages.xd.team',
};

test('access-key login stores secret without printing it', async () => {
  const writes = [];
  const output = [];

  await loginWithAccessKey({
    config: productionConfig,
    accessKey: 'xdpak_production_ak_1_secret',
    secretStore: {
      set: async (environment, credential) => writes.push({ environment, credential }),
    },
    profile: { activeEnvironment: 'production', environments: {} },
    saveProfile: async (profile) => writes.push({ profile }),
    now: () => '2026-06-15T00:00:00.000Z',
    output: (line) => output.push(line),
  });

  assert.deepEqual(writes[0], {
    environment: 'production',
    credential: {
      type: 'access_key',
      value: 'xdpak_production_ak_1_secret',
      savedAt: '2026-06-15T00:00:00.000Z',
      expiresAt: undefined,
    },
  });
  assert.equal(output.join('\n').includes('xdpak_production_ak_1_secret'), false);
});

test('browser login opens authorize URL, polls, and stores CLI token once confirmed', async () => {
  const requests = [];
  const opened = [];
  const writes = [];
  const output = [];
  const responses = [
    {
      loginId: 'cli_1',
      loginSecret: 'sec_1',
      deviceCode: '12345678',
      browserUrl: 'https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_1',
      expiresAt: 2_000,
    },
    { status: 'pending' },
    { status: 'confirmed', cliToken: 'cli_token_secret', expiresAt: 3_000 },
  ];

  await loginWithBrowser({
    config: productionConfig,
    secretStore: {
      set: async (environment, credential) => writes.push({ environment, credential }),
    },
    profile: { activeEnvironment: 'production', environments: {} },
    saveProfile: async (profile) => writes.push({ profile }),
    fetch: async (request) => {
      requests.push(request);
      return Response.json(responses.shift());
    },
    openBrowser: async (url) => opened.push(url),
    sleep: async () => {},
    nowSeconds: () => 1_000,
    nowIso: () => '2026-06-15T00:00:00.000Z',
    output: (line) => output.push(line),
    pollIntervalMs: 0,
  });

  assert.equal(requests[0].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/start');
  assert.equal(requests[1].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/poll');
  assert.equal(requests[2].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/poll');
  assert.deepEqual(opened, ['https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_1']);
  assert.deepEqual(writes[0], {
    environment: 'production',
    credential: {
      type: 'cli_token',
      value: 'cli_token_secret',
      savedAt: '2026-06-15T00:00:00.000Z',
      expiresAt: 3_000,
    },
  });
  assert.equal(output.join('\n').includes('sec_1'), false);
  assert.equal(output.join('\n').includes('cli_token_secret'), false);
  assert.match(output.join('\n'), /12345678/);
  assert.match(output.join('\n'), /production/);
  assert.match(output.join('\n'), /auth\.pages\.xd\.team/);
  assert.match(output.join('\n'), /api\.pages\.xd\.team/);
  assert.match(output.join('\n'), /cli_token/);
});

test('browser login respects --no-open and fails on expiry', async () => {
  const opened = [];
  await assert.rejects(
    () =>
      loginWithBrowser({
        config: productionConfig,
        secretStore: { set: async () => {} },
        profile: { activeEnvironment: 'production', environments: {} },
        saveProfile: async () => {},
        fetch: async () =>
          Response.json({
            loginId: 'cli_1',
            loginSecret: 'sec_1',
            deviceCode: '12345678',
            browserUrl: 'https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_1',
            expiresAt: 999,
          }),
        openBrowser: async (url) => opened.push(url),
        noOpen: true,
        sleep: async () => {},
        nowSeconds: () => 1_000,
        output: () => {},
      }),
    /CLI_LOGIN_EXPIRED/
  );
  assert.deepEqual(opened, []);
});
