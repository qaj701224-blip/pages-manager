import { createApiClient } from './api-client.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 180;

export async function loginWithAccessKey({
  config,
  accessKey,
  secretStore,
  profile,
  saveProfile,
  now = () => new Date().toISOString(),
  output = () => {},
}) {
  if (typeof accessKey !== 'string' || accessKey.trim() === '') throw new Error('ACCESS_KEY_REQUIRED');
  const savedAt = now();
  await secretStore.set(config.environment, {
    type: 'access_key',
    value: accessKey,
    savedAt,
    expiresAt: undefined,
  });
  await saveLoginProfile({ config, profile, saveProfile, credentialType: 'access_key', savedAt });
  output(`Logged in to ${config.environment} with a Pages access key.`);
}

export async function loginWithBrowser({
  config,
  secretStore,
  profile,
  saveProfile,
  fetch = globalThis.fetch,
  openBrowser = defaultOpenBrowser,
  sleep = defaultSleep,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  nowIso = () => new Date().toISOString(),
  output = () => {},
  noOpen = false,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}) {
  const client = createApiClient({
    apiBaseUrl: config.apiBaseUrl,
    authBaseUrl: config.authBaseUrl,
    fetch,
  });

  const start = await client.requestAuth('POST', '/.xd-pages/cli/login/start');
  assertLoginStart(start);
  output(`Device code: ${start.deviceCode}`);
  output(`Open: ${start.browserUrl}`);

  if (nowSeconds() >= start.expiresAt) throw new Error('CLI_LOGIN_EXPIRED');
  if (!noOpen) await openBrowser(start.browserUrl);

  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    if (nowSeconds() >= start.expiresAt) throw new Error('CLI_LOGIN_EXPIRED');
    const status = await client.requestAuth('POST', '/.xd-pages/cli/login/poll', {
      loginId: start.loginId,
      loginSecret: start.loginSecret,
    });

    if (status?.status === 'confirmed') {
      if (typeof status.cliToken !== 'string' || status.cliToken === '') throw new Error('CLI_TOKEN_MISSING');
      const savedAt = nowIso();
      await secretStore.set(config.environment, {
        type: 'cli_token',
        value: status.cliToken,
        savedAt,
        expiresAt: status.expiresAt,
      });
      await saveLoginProfile({ config, profile, saveProfile, credentialType: 'cli_token', savedAt });
      output(`Logged in to ${config.environment}.`);
      return;
    }
    if (status?.status !== 'pending') throw new Error('CLI_LOGIN_INVALID_STATUS');
    await sleep(pollIntervalMs);
  }

  throw new Error('CLI_LOGIN_TIMEOUT');
}

async function saveLoginProfile({ config, profile, saveProfile, credentialType, savedAt }) {
  const nextProfile = {
    ...profile,
    activeEnvironment: config.environment,
    environments: {
      ...(profile.environments || {}),
      [config.environment]: {
        ...profile.environments?.[config.environment],
        credentialType,
        lastLoginAt: savedAt,
      },
    },
  };
  await saveProfile(nextProfile);
}

function assertLoginStart(start) {
  if (
    !start ||
    typeof start.loginId !== 'string' ||
    typeof start.loginSecret !== 'string' ||
    typeof start.deviceCode !== 'string' ||
    typeof start.browserUrl !== 'string' ||
    !Number.isFinite(start.expiresAt)
  ) {
    throw new Error('CLI_LOGIN_START_INVALID');
  }
}

async function defaultOpenBrowser(url) {
  const { execFile } = await import('node:child_process');
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
