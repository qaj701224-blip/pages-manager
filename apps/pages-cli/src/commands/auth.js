import { loginWithAccessKey, loginWithBrowser } from '../login.js';
import { saveProfile as saveProfileFile } from '../profile.js';
import { createSecretStore } from '../secret-store.js';

import {
  assertNoPositionals,
  assertTokenNotUsed,
  createClient,
  outputJsonResult,
  readConfigForCommand,
  readOneShotToken,
  resolveCredential,
  usageError,
} from './shared.js';

export async function runAuth(parsed, context) {
  const subcommand = parsed.positional[0] || 'status';
  const child = { ...parsed, command: `auth ${subcommand}`, positional: parsed.positional.slice(1) };
  if (subcommand === 'login') return runLogin(child, context);
  if (subcommand === 'status') return runAuthStatus(child, context);
  if (subcommand === 'whoami') return runWhoami(child, context);
  if (subcommand === 'logout') return runAuthLogout(child, context);
  throw usageError(
    'AUTH_COMMAND_INVALID',
    'auth 命令无效。',
    '请使用 xd-cell auth login、xd-cell auth status、xd-cell auth whoami 或 xd-cell auth logout。'
  );
}

export async function runLogin(parsed, context) {
  assertNoPositionals(parsed, 'LOGIN_USAGE_INVALID', 'xd-cell login 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const secretStore = context.secretStore || createSecretStore({ profileDir: context.profileDir, platform: context.platform });
  const saveProfile = (profile) => saveProfileFile(context.profileDir, profile);
  const output = parsed.flags.json ? () => {} : context.output;

  const token = readOneShotToken(parsed);
  if (token) {
    await loginWithAccessKey({
      config,
      accessKey: token,
      secretStore,
      profile: context.profile,
      saveProfile,
      fetch: context.fetch,
      now: context.nowIso,
      output,
    });
    outputJsonResult(parsed, context, { environment: config.environment, credentialType: 'access_key' });
    return 0;
  }

  await loginWithBrowser({
    config,
    secretStore,
    profile: context.profile,
    saveProfile,
    fetch: context.fetch,
    openBrowser: context.openBrowser,
    sleep: context.sleep,
    nowSeconds: context.nowSeconds,
    nowIso: context.nowIso,
    output,
    onChallenge: parsed.flags.json
      ? (challenge) => {
          context.output(JSON.stringify({ ok: true, schemaVersion: 1, type: 'login_challenge', ...challenge }));
        }
      : null,
    noOpen: Boolean(parsed.flags.noOpen),
    pollIntervalMs: context.pollIntervalMs,
  });
  outputJsonResult(parsed, context, { environment: config.environment, credentialType: 'cli_token' });
  return 0;
}

export async function runAuthStatus(parsed, context) {
  assertTokenNotUsed(parsed);
  assertNoPositionals(parsed, 'AUTH_STATUS_USAGE_INVALID', 'xd-cell auth status 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const secretStore = context.secretStore || createSecretStore({ profileDir: context.profileDir, platform: context.platform });
  const credential = await secretStore.get(config.environment);
  const payload = {
    environment: config.environment,
    authenticated: Boolean(credential),
    credentialType: credential?.type || null,
  };
  if (outputJsonResult(parsed, context, payload)) return 0;
  context.output(credential ? `已登录 ${config.environment}，凭证类型：${credential.type}` : `未登录 ${config.environment}`);
  return 0;
}

export async function runWhoami(parsed, context) {
  assertNoPositionals(parsed, 'AUTH_WHOAMI_USAGE_INVALID', 'xd-cell auth whoami 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const result = await createClient(config, credential, context).requestApi('GET', '/.xd-pages/api/auth/whoami');
  if (outputJsonResult(parsed, context, result)) return 0;
  context.output(JSON.stringify(result));
  return 0;
}

export async function runAuthLogout(parsed, context) {
  assertTokenNotUsed(parsed);
  assertNoPositionals(parsed, 'AUTH_LOGOUT_USAGE_INVALID', 'xd-cell auth logout 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const secretStore = context.secretStore || createSecretStore({ profileDir: context.profileDir, platform: context.platform });
  if (typeof secretStore.delete === 'function') await secretStore.delete(config.environment);
  await saveProfileFile(context.profileDir, {
    ...context.profile,
    environments: {
      ...(context.profile.environments || {}),
      [config.environment]: {
        ...(context.profile.environments?.[config.environment] || {}),
        credentialType: undefined,
        lastLoginAt: undefined,
      },
    },
  });
  if (outputJsonResult(parsed, context, { environment: config.environment, loggedOut: true })) return 0;
  context.output(`已退出 ${config.environment}`);
  return 0;
}
