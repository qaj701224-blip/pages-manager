import { FIXED_ENVIRONMENTS } from '../config.js';
import { saveProfile as saveProfileFile } from '../profile.js';

import {
  USER_ENVIRONMENTS,
  assertNoPositionals,
  assertTokenNotUsed,
  outputJsonResult,
  readConfigForCommand,
  readHiddenEnvironment,
  usageError,
} from './shared.js';

export async function runEnv(parsed, context) {
  assertTokenNotUsed(parsed);
  const subcommand = parsed.positional[0] || 'current';
  if (subcommand === 'current') {
    assertNoPositionals({ ...parsed, positional: parsed.positional.slice(1) }, 'ENV_USAGE_INVALID', 'env current 参数无效。');
    const config = readConfigForCommand(parsed, context, { allowHiddenEnvironmentSources: true });
    const payload = {
      activeEnvironment: config.environment,
      source: readEnvironmentSource(context),
      apiBaseUrl: config.apiBaseUrl,
      authBaseUrl: config.authBaseUrl,
      siteUrlExample: siteUrlExampleForConfig(config),
    };
    if (outputJsonResult(parsed, context, payload)) return 0;
    context.output(`当前环境：${payload.activeEnvironment}`);
    context.output(`API：${payload.apiBaseUrl}`);
    context.output(`认证：${payload.authBaseUrl}`);
    context.output(`站点域名：${siteDomainPatternForConfig(config)}`);
    context.output(`来源：${displayEnvironmentSource(payload.source)}`);
    return 0;
  }

  if (subcommand === 'list') {
    if (parsed.positional.length !== 1 && parsed.positional.length !== 0) {
      throw usageError('ENV_USAGE_INVALID', 'env list 参数无效。', '请使用 xd-cell env list。');
    }
    if (outputJsonResult(parsed, context, { environments: USER_ENVIRONMENTS })) return 0;
    for (const name of USER_ENVIRONMENTS) context.output(name);
    return 0;
  }

  if (subcommand === 'use') {
    if (parsed.positional.length !== 2) {
      throw usageError('ENV_USAGE_INVALID', 'env use 参数无效。', '请使用 xd-cell env use <production|staging>。');
    }
    const environment = readHiddenEnvironment(parsed.positional[1]);
    await saveProfileFile(context.profileDir, {
      ...context.profile,
      activeEnvironment: environment,
    });
    if (outputJsonResult(parsed, context, { activeEnvironment: environment })) return 0;
    context.output(`当前环境：${environment}`);
    return 0;
  }

  throw usageError('ENV_COMMAND_INVALID', 'env 命令不完整或无效。', '请使用 xd-cell env、xd-cell env list 或 xd-cell env use <环境>。');
}

function siteUrlExampleForConfig(config) {
  if (config.environment === 'staging') return `https://<site>-staging.${config.siteDomainSuffix}`;
  return `https://<site>.${config.siteDomainSuffix}`;
}

function siteDomainPatternForConfig(config) {
  if (config.environment === 'staging') return `*-staging.${config.siteDomainSuffix}`;
  return `*.${config.siteDomainSuffix}`;
}

function readEnvironmentSource(context) {
  if (context.env.PAGES_CLI_ENV) return 'env:PAGES_CLI_ENV';
  if (context.profile?.activeEnvironment) return 'profile';
  if (context.env.PAGES_ENV) return 'env:PAGES_ENV';
  return 'default';
}

function displayEnvironmentSource(source) {
  if (source === 'profile') return '本地 profile';
  if (source === 'env:PAGES_CLI_ENV') return '环境变量 PAGES_CLI_ENV';
  if (source === 'env:PAGES_ENV') return '环境变量 PAGES_ENV';
  return '默认值';
}

export function listFixedEnvironments() {
  return Object.keys(FIXED_ENVIRONMENTS);
}
