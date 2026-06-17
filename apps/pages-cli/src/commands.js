import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseArgs } from './args.js';
import { createApiClient } from './api-client.js';
import { buildAssetArtifact, buildArtifactBundle, hashArtifact, inferArtifactKind } from './artifact.js';
import { readCommandConfig } from './command-config.js';
import { FIXED_ENVIRONMENTS, readCliConfig, resolveEnvironment } from './config.js';
import { loginWithAccessKey, loginWithBrowser } from './login.js';
import { loadProfile, resolveProfileDir, saveProfile as saveProfileFile } from './profile.js';
import { createSecretStore } from './secret-store.js';

const VALID_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const VALID_ARTIFACT_KINDS = new Set(['static', 'spa', 'worker']);
const USER_ENVIRONMENTS = ['production', 'staging'];
const HELP_FLAGS = new Set(['help', 'json', 'accessKey']);
const VERSION_FLAGS = new Set(['help', 'accessKey']);
const LOGIN_FLAGS = new Set(['env', 'accessKey', 'noOpen', 'json', 'help']);
const DEPLOY_FLAGS = new Set([
  'env',
  'visibility',
  'artifactKind',
  'accessKey',
  'config',
  'json',
  'help',
  'slug',
  'site',
  'saveConfig',
]);
const API_READ_FLAGS = new Set(['env', 'accessKey', 'json', 'help']);
const STATUS_FLAGS = new Set(['env', 'deployment', 'accessKey', 'json', 'help']);
const ROLLBACK_FLAGS = new Set(['env', 'accessKey', 'json', 'help']);
const OPEN_FLAGS = new Set(['env', 'print', 'json', 'help', 'accessKey']);
const ACCESS_FLAGS = new Set(['env', 'visibility', 'email', 'department', 'accessKey', 'json', 'help']);
const ENV_FLAGS = new Set(['json', 'help', 'accessKey']);
const ENV_CUSTOM_FLAGS = new Set(['api', 'auth', 'siteDomainSuffix', 'json', 'help', 'accessKey']);

export async function executeCommand(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  validateCommandUsage(parsed);
  const output = options.output || createOutput(options.stdout);
  if (parsed.command === 'help' || parsed.flags.help) {
    assertAccessKeyNotUsed(parsed);
    outputHelp(parsed, output);
    return 0;
  }
  if (parsed.command === 'version') {
    assertAccessKeyNotUsed(parsed);
    assertNoPositionals(parsed, 'VERSION_USAGE_INVALID', 'pages version 不接受位置参数。');
    output(await readCliVersion());
    return 0;
  }

  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const profileDir = options.profileDir || resolveProfileDir({ env, platform: options.platform, homedir: options.homedir });
  const profile = options.profile || (await loadProfile(profileDir));

  switch (parsed.command) {
    case 'login':
      return runLogin(parsed, { ...options, env, profileDir, profile, output });
    case 'auth':
      return runAuth(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'deploy':
      return runDeploy(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'status':
      return runStatus(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'rollback':
      return runRollback(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'open':
      return runOpen(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'sites':
      return runSites(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'access':
      return runAccess(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'env':
      assertAccessKeyNotUsed(parsed);
      return runEnv(parsed, { ...options, env, profileDir, profile, output });
    default:
      throw new Error(`UNKNOWN_COMMAND:${parsed.command}`);
  }
}

async function runAuth(parsed, context) {
  const subcommand = parsed.positional[0] || 'status';
  const child = { ...parsed, command: `auth ${subcommand}`, positional: parsed.positional.slice(1) };
  if (subcommand === 'login') return runLogin(child, context);
  if (subcommand === 'status') return runAuthStatus(child, context);
  if (subcommand === 'whoami') return runWhoami(child, context);
  if (subcommand === 'logout') return runAuthLogout(child, context);
  throw usageError(
    'AUTH_COMMAND_INVALID',
    'auth 命令无效。',
    '请使用 pages auth login、pages auth status、pages auth whoami 或 pages auth logout。'
  );
}

async function runLogin(parsed, context) {
  assertNoPositionals(parsed, 'LOGIN_USAGE_INVALID', 'pages login 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const secretStore = context.secretStore || createSecretStore({ profileDir: context.profileDir, platform: context.platform });
  const saveProfile = (profile) => saveProfileFile(context.profileDir, profile);
  const output = parsed.flags.json ? () => {} : context.output;

  if (parsed.flags.accessKey) {
    await loginWithAccessKey({
      config,
      accessKey: parsed.flags.accessKey,
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

async function runAuthStatus(parsed, context) {
  assertAccessKeyNotUsed(parsed);
  assertNoPositionals(parsed, 'AUTH_STATUS_USAGE_INVALID', 'pages auth status 不接受位置参数。');
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

async function runWhoami(parsed, context) {
  assertNoPositionals(parsed, 'AUTH_WHOAMI_USAGE_INVALID', 'pages auth whoami 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const result = await createClient(config, credential, context).requestApi('GET', '/.xd-pages/api/auth/whoami');
  if (outputJsonResult(parsed, context, result)) return 0;
  context.output(JSON.stringify(result));
  return 0;
}

async function runAuthLogout(parsed, context) {
  assertAccessKeyNotUsed(parsed);
  assertNoPositionals(parsed, 'AUTH_LOGOUT_USAGE_INVALID', 'pages auth logout 不接受位置参数。');
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

async function runDeploy(parsed, context) {
  rejectRemovedProjectFlags(parsed);
  const commandConfig = await readCommandConfig(parsed.flags.config, { cwd: context.cwd });
  const config = readConfigForCommand(parsed, { ...context, commandConfig });
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);
  if (parsed.positional.length > 2) throw usageError('USAGE_INVALID', 'deploy 参数过多。', '请使用 pages deploy <目录> <站点名>。');

  const dirInput = parsed.positional[0] || commandConfig?.dir;
  const siteSlug = normalizeSiteSlug(parsed.positional[1] || commandConfig?.site);
  if (!dirInput) throw usageError('DIR_REQUIRED', '缺少发布目录。', '请使用 pages deploy <目录> <站点名>，或通过 --config <file> 提供 dir。');
  if (!siteSlug) throw usageError('SITE_REQUIRED', '缺少站点名。', '请使用 pages deploy <目录> <站点名>，或通过 --config <file> 提供 site。');

  const targetPath = path.resolve(context.cwd, dirInput);
  const artifactKind = parsed.flags.artifactKind || commandConfig?.artifactKind || (await inferArtifactKind(targetPath));
  if (!VALID_ARTIFACT_KINDS.has(artifactKind)) {
    throw usageError('ARTIFACT_KIND_INVALID', 'artifact 类型无效。', '请使用 static、spa 或 worker。');
  }

  const requestedVisibility = parsed.flags.visibility || commandConfig?.visibility;
  if (requestedVisibility && !VALID_VISIBILITIES.has(requestedVisibility)) {
    throw usageError('SITE_VISIBILITY_INVALID', '站点可见性无效。', '请使用 internal、org、acl、owner 或 disabled。');
  }

  if (credential.type !== 'access_key') {
    const visibility = requestedVisibility || 'org';
    try {
      await client.requestApi('POST', '/.xd-pages/api/sites', { slug: siteSlug, visibility });
    } catch (error) {
      if (error?.code !== 'SITE_SLUG_CONFLICT') throw error;
    }
  }

  const artifact = await hashArtifact(targetPath);
  const deployed =
    artifactKind === 'worker'
      ? await client.requestApi(
          'POST',
          '/.xd-pages/api/deployments',
          {
            siteSlug,
            artifactKind,
            contentHash: artifact.contentHash,
            artifactBundle: await buildArtifactBundle(targetPath, artifactKind),
            source: 'cli',
          },
          { idempotencyKey: nextIdempotencyKey(context) }
        )
      : await client.requestApiForm(
          'POST',
          '/.xd-pages/api/deployments',
          await buildAssetDeploymentForm({
            siteSlug,
            artifactKind,
            contentHash: artifact.contentHash,
            targetPath,
          }),
          { idempotencyKey: nextIdempotencyKey(context) }
        );

  const url = deployed.route?.hostname ? `https://${deployed.route.hostname}` : siteUrlForSlug(siteSlug, config);
  if (
    outputJsonResult(parsed, context, {
      environment: config.environment,
      site: siteSlug,
      artifactKind,
      deployment: deployed.deployment || null,
      version: deployed.version || null,
      route: deployed.route || null,
      url,
    })
  ) {
    return 0;
  }
  context.output(`站点名：${siteSlug}`);
  context.output(`部署：${deployed.deployment?.id || 'created'} ${deployed.deployment?.status || ''}`.trim());
  if (url) context.output(`URL ${url}`);
  return 0;
}

async function buildAssetDeploymentForm({ siteSlug, artifactKind, contentHash, targetPath }) {
  const artifact = await buildAssetArtifact(targetPath, artifactKind);
  const form = new FormData();
  form.set('siteSlug', siteSlug);
  form.set('artifactKind', artifactKind);
  form.set('contentHash', contentHash);
  form.set('source', 'cli');
  form.set('assetManifest', JSON.stringify(artifact.manifest));
  form.set('assetFileCount', String(artifact.fileCount));
  form.set('assetSizeBytes', String(artifact.sizeBytes));

  artifact.files.forEach((file, index) => {
    form.set(`file-${index}`, new Blob([file.bytes], { type: file.contentType }), file.relativePath);
  });
  return form;
}

async function runStatus(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  if (parsed.flags.deployment) {
    assertNoPositionals(parsed, 'STATUS_USAGE_INVALID', '按 deployment 查询时不接受站点名。');
    const result = await client.requestApi('GET', `/.xd-pages/api/deployments/${encodeURIComponent(parsed.flags.deployment)}`);
    if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
    context.output(JSON.stringify(result));
    return 0;
  }

  const site = readSingleSiteArg(parsed, 'STATUS_USAGE_INVALID', '请使用 pages status <站点名>。');
  const result = await readSiteBySlug(client, site);
  if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
  context.output(JSON.stringify(result));
  return 0;
}

async function runRollback(parsed, context) {
  if (parsed.positional.length !== 2) {
    throw usageError('ROLLBACK_USAGE_INVALID', 'rollback 参数无效。', '请使用 pages rollback <站点名> <version-id>。');
  }
  const [site, versionId] = parsed.positional;
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);
  const result = await client.requestApi(
    'POST',
    `/.xd-pages/api/versions/${encodeURIComponent(versionId)}/rollback`,
    { siteSlug: site },
    {
      idempotencyKey: nextIdempotencyKey(context),
    }
  );
  if (outputJsonResult(parsed, context, { environment: config.environment, site, ...result })) return 0;
  context.output(`站点名：${site}`);
  context.output(`回滚：${result.deployment?.id || 'created'} ${result.deployment?.status || ''}`.trim());
  return 0;
}

async function runOpen(parsed, context) {
  assertAccessKeyNotUsed(parsed);
  const config = readConfigForCommand(parsed, context);
  const site = readSingleSiteArg(parsed, 'OPEN_USAGE_INVALID', '请使用 pages open <站点名>。');
  const url = siteUrlForSlug(site, config);
  if (outputJsonResult(parsed, context, { environment: config.environment, site, url })) return 0;
  if (parsed.flags.print) {
    context.output(url);
    return 0;
  }
  await (context.openUrl || defaultOpenUrl)(url);
  context.output(url);
  return 0;
}

async function runSites(parsed, context) {
  const subcommand = parsed.positional[0] || 'list';
  const child = { ...parsed, positional: parsed.positional.slice(1) };
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  if (subcommand === 'list') {
    assertNoPositionals(child, 'SITES_LIST_USAGE_INVALID', 'pages sites list 不接受位置参数。');
    const result = await client.requestApi('GET', '/.xd-pages/api/sites');
    if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
    context.output(JSON.stringify(result));
    return 0;
  }

  if (subcommand === 'info') {
    const site = readSingleSiteArg(child, 'SITES_INFO_USAGE_INVALID', '请使用 pages sites info <站点名>。');
    const result = await readSiteBySlug(client, site);
    if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
    context.output(JSON.stringify(result));
    return 0;
  }

  throw usageError('SITES_COMMAND_INVALID', 'sites 命令无效。', '请使用 pages sites list 或 pages sites info <站点名>。');
}

async function runAccess(parsed, context) {
  const subcommand = parsed.positional[0] || 'get';
  const child = { ...parsed, positional: parsed.positional.slice(1) };
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  if (subcommand === 'get') {
    assertFlagsAbsent(parsed, ['visibility', 'email', 'department'], 'ACCESS_GET_USAGE_INVALID', 'access get 不接受访问范围设置参数。');
    const siteSlug = readSingleSiteArg(child, 'ACCESS_GET_USAGE_INVALID', '请使用 pages access get <站点名>。');
    const { site } = await readSiteBySlug(client, siteSlug);
    const result = await client.requestApi('GET', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}/acl`);
    const summary = summarizeAccessEntries(result.aclEntries || []);
    return outputAccessResult(parsed, context, {
      environment: config.environment,
      site: site.slug,
      visibility: readSiteVisibility(site),
      ...summary,
    });
  }

  if (subcommand === 'set') {
    const siteSlug = readSingleSiteArg(child, 'ACCESS_SET_USAGE_INVALID', '请使用 pages access set <站点名> --visibility <范围>。');
    const visibility = normalizeVisibility(parsed.flags.visibility);
    if (!visibility) {
      if (parsed.flags.visibility !== undefined) {
        throw usageError('ACCESS_VISIBILITY_INVALID', '访问范围无效。', '请使用 internal、org、acl、owner 或 disabled。');
      }
      throw usageError('ACCESS_VISIBILITY_REQUIRED', '缺少访问范围。', '请传入 --visibility internal|org|acl|owner|disabled。');
    }
    const requested = readAccessEntryFlags(parsed, { requireEntry: false });
    if (visibility !== 'acl' && requested.entries.length > 0) {
      throw usageError('ACCESS_ENTRIES_UNUSED', '当前访问范围不使用邮箱或部门名单。', '只有 --visibility acl 可以同时传 --email 或 --department。');
    }

    const { site } = await readSiteBySlug(client, siteSlug);
    let updated = { site };
    let summary = { emails: [], departments: [], aclEntries: [] };
    if (visibility === 'acl') {
      const result = await client.requestApi('PUT', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}/acl`, {
        entries: requested.entries,
      });
      summary = summarizeAccessEntries(result.aclEntries || []);
    }
    updated = await client.requestApi('PATCH', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}`, { visibility });
    return outputAccessResult(parsed, context, {
      environment: config.environment,
      site: updated.site?.slug || site.slug,
      visibility,
      emails: summary.emails,
      departments: summary.departments,
    });
  }

  if (subcommand === 'grant' || subcommand === 'revoke') {
    assertFlagsAbsent(
      parsed,
      ['visibility'],
      subcommand === 'grant' ? 'ACCESS_GRANT_USAGE_INVALID' : 'ACCESS_REVOKE_USAGE_INVALID',
      `access ${subcommand} 不接受 --visibility。`
    );
    const siteSlug = readSingleSiteArg(
      child,
      subcommand === 'grant' ? 'ACCESS_GRANT_USAGE_INVALID' : 'ACCESS_REVOKE_USAGE_INVALID',
      `请使用 pages access ${subcommand} <站点名> --email <邮箱> 或 --department <部门路径>。`
    );
    const requested = readAccessEntryFlags(parsed, { requireEntry: true });
    const { site } = await readSiteBySlug(client, siteSlug);
    if (readSiteVisibility(site) !== 'acl') {
      throw usageError('ACCESS_VISIBILITY_NOT_ACL', '站点当前不是 acl 访问范围。', firstAclSetAction(siteSlug, requested));
    }
    const method = subcommand === 'grant' ? 'POST' : 'DELETE';
    const result = await client.requestApi(method, `/.xd-pages/api/sites/${encodeURIComponent(site.id)}/acl/entries`, {
      entries: requested.entries,
    });
    const summary = summarizeAccessEntries(result.aclEntries || []);
    return outputAccessResult(parsed, context, {
      environment: config.environment,
      site: site.slug,
      visibility: 'acl',
      emails: summary.emails,
      departments: summary.departments,
    });
  }

  throw usageError(
    'ACCESS_COMMAND_INVALID',
    'access 命令无效。',
    '请使用 pages access get、set、grant 或 revoke。'
  );
}

async function runEnv(parsed, context) {
  const subcommand = parsed.positional[0] || 'current';
  if (subcommand === 'current') {
    assertNoPositionals({ ...parsed, positional: parsed.positional.slice(1) }, 'ENV_USAGE_INVALID', 'env current 参数无效。');
    const config = readConfigForCommand(parsed, context);
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
      throw usageError('ENV_USAGE_INVALID', 'env list 参数无效。', '请使用 pages env list。');
    }
    if (outputJsonResult(parsed, context, { environments: USER_ENVIRONMENTS })) return 0;
    for (const name of USER_ENVIRONMENTS) context.output(name);
    return 0;
  }

  if (subcommand === 'use') {
    if (parsed.positional.length !== 2) {
      throw usageError('ENV_USAGE_INVALID', 'env use 参数无效。', '请使用 pages env use <production|staging>。');
    }
    const environment = resolveEnvironment(parsed.positional[1]);
    if (!USER_ENVIRONMENTS.includes(environment) && environment !== 'custom') {
      throw usageError('ENVIRONMENT_INVALID', '环境无效。', '请使用 production 或 staging。');
    }
    await saveProfileFile(context.profileDir, {
      ...context.profile,
      activeEnvironment: environment,
    });
    if (outputJsonResult(parsed, context, { activeEnvironment: environment })) return 0;
    context.output(`当前环境：${environment}`);
    return 0;
  }

  if (subcommand === 'set' && parsed.positional[1] === 'custom') {
    if (parsed.positional.length !== 2) {
      throw usageError('ENV_USAGE_INVALID', 'env set custom 参数无效。', '请使用 pages env set custom。');
    }
    const custom = readCliConfig(context.env, {
      environment: 'custom',
      apiBaseUrl: parsed.flags.api,
      authBaseUrl: parsed.flags.auth,
      siteDomainSuffix: parsed.flags.siteDomainSuffix,
    });
    await saveProfileFile(context.profileDir, {
      ...context.profile,
      activeEnvironment: 'custom',
      environments: {
        ...(context.profile.environments || {}),
        custom,
      },
    });
    if (outputJsonResult(parsed, context, { activeEnvironment: 'custom', custom })) return 0;
    context.output('已保存 custom 环境。');
    return 0;
  }

  throw usageError('ENV_COMMAND_INVALID', 'env 命令不完整或无效。', '请使用 pages env、pages env list 或 pages env use <环境>。');
}

function validateCommandUsage(parsed) {
  const allowed = allowedFlagsForCommand(parsed);
  if (allowed) assertOnlyAllowedFlags(parsed, allowed);
  if (parsed.command === 'help' && parsed.positional.length > 1) {
    throw usageError('HELP_USAGE_INVALID', 'help 参数无效。', '请使用 pages help 或 pages help <命令>。');
  }
}

function allowedFlagsForCommand(parsed) {
  if (parsed.command === 'help') return HELP_FLAGS;
  if (parsed.command === 'version') return VERSION_FLAGS;
  if (parsed.command === 'login') return LOGIN_FLAGS;
  if (parsed.command === 'deploy') return DEPLOY_FLAGS;
  if (parsed.command === 'status') return STATUS_FLAGS;
  if (parsed.command === 'rollback') return ROLLBACK_FLAGS;
  if (parsed.command === 'open') return OPEN_FLAGS;
  if (parsed.command === 'sites') return API_READ_FLAGS;
  if (parsed.command === 'access') return ACCESS_FLAGS;
  if (parsed.command === 'auth') return allowedAuthFlags(parsed);
  if (parsed.command === 'env') return allowedEnvFlags(parsed);
  return null;
}

function allowedAuthFlags(parsed) {
  const subcommand = parsed.positional[0] || 'status';
  if (subcommand === 'login') return LOGIN_FLAGS;
  if (subcommand === 'status' || subcommand === 'logout') return ENV_FLAGS;
  if (subcommand === 'whoami') return API_READ_FLAGS;
  return API_READ_FLAGS;
}

function allowedEnvFlags(parsed) {
  if (parsed.positional[0] === 'set' && parsed.positional[1] === 'custom') return ENV_CUSTOM_FLAGS;
  return ENV_FLAGS;
}

function assertOnlyAllowedFlags(parsed, allowed) {
  for (const flag of Object.keys(parsed.flags)) {
    if (allowed.has(flag)) continue;
    throw usageError('OPTION_UNKNOWN', `未知选项：--${displayFlagName(flag)}`, helpActionForCommand(parsed.command));
  }
}

function assertFlagsAbsent(parsed, flags, code, message) {
  for (const flag of flags) {
    if (parsed.flags[flag] !== undefined) {
      throw usageError(code, message, '请运行 pages help access 查看用法。');
    }
  }
}

function displayFlagName(flag) {
  return flag.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function helpActionForCommand(command) {
  if (command && command !== 'help' && command !== 'version') return `请运行 pages help ${command} 查看可用选项。`;
  return '请运行 pages help 查看可用选项。';
}

async function readSiteBySlug(client, slug) {
  const result = await client.requestApi('GET', '/.xd-pages/api/sites');
  const site = Array.isArray(result?.sites) ? result.sites.find((candidate) => candidate.slug === slug) : null;
  if (!site) {
    throw usageError('SITE_NOT_FOUND', `未找到站点：${slug}`, '请确认站点名和当前环境；如果使用 access key，请确认它绑定的是这个站点。');
  }
  return { site };
}

function readConfigForCommand(parsed, context) {
  const requestedEnvironment =
    parsed.flags.env ||
    context.commandConfig?.environment ||
    context.env.PAGES_CLI_ENV ||
    context.profile?.activeEnvironment ||
    context.env.PAGES_ENV ||
    'production';
  if (requestedEnvironment === 'custom') {
    const custom = context.profile?.environments?.custom || {};
    return readCliConfig(context.env, {
      environment: 'custom',
      apiBaseUrl: parsed.flags.api || custom.apiBaseUrl,
      authBaseUrl: parsed.flags.auth || custom.authBaseUrl,
      siteDomainSuffix: parsed.flags.siteDomainSuffix || custom.siteDomainSuffix,
    });
  }
  return readCliConfig(context.env, { environment: requestedEnvironment });
}

async function resolveCredential(environment, context, parsed) {
  if (parsed.flags.accessKey) {
    return {
      type: 'access_key',
      value: parsed.flags.accessKey,
    };
  }
  if (context.env.PAGES_ACCESS_KEY) {
    return {
      type: 'access_key',
      value: context.env.PAGES_ACCESS_KEY,
    };
  }
  const secretStore = context.secretStore || createSecretStore({ profileDir: context.profileDir, platform: context.platform });
  const credential = await secretStore.get(environment);
  if (!credential) throw new Error('PAGES_CREDENTIAL_REQUIRED');
  return credential;
}

function createClient(config, credential, context) {
  return createApiClient({
    apiBaseUrl: config.apiBaseUrl,
    authBaseUrl: config.authBaseUrl,
    credential,
    fetch: context.fetch,
  });
}

function siteUrlForSlug(slug, config) {
  const normalized = normalizeSiteSlug(slug);
  if (!normalized) throw usageError('SITE_REQUIRED', '缺少站点名。', '请传入站点名。');
  if (config.environment === 'staging') return `https://${normalized}-staging.${config.siteDomainSuffix}`;
  return `https://${normalized}.${config.siteDomainSuffix}`;
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

function normalizeSiteSlug(value) {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return slug || null;
}

function readSingleSiteArg(parsed, code, action) {
  if (parsed.positional.length !== 1) {
    throw usageError(
      parsed.positional.length === 0 ? 'SITE_REQUIRED' : code,
      parsed.positional.length === 0 ? '缺少站点名。' : '位置参数无效。',
      action
    );
  }
  const site = normalizeSiteSlug(parsed.positional[0]);
  if (!site) throw usageError('SITE_REQUIRED', '缺少站点名。', action);
  return site;
}

function normalizeVisibility(value) {
  const visibility = typeof value === 'string' ? value.trim() : '';
  return VALID_VISIBILITIES.has(visibility) ? visibility : '';
}

function readAccessEntryFlags(parsed, { requireEntry }) {
  const emails = normalizeRepeatedFlag(parsed.flags.email).map(normalizeEmail);
  const departments = normalizeRepeatedFlag(parsed.flags.department).map(normalizeDepartmentPath);
  if (emails.some((email) => !isValidEmail(email))) {
    throw usageError('ACCESS_EMAIL_INVALID', '邮箱格式无效。', '请传入完整邮箱，例如 --email user@xd.com。');
  }
  if (departments.some((department) => !department)) {
    throw usageError('ACCESS_DEPARTMENT_INVALID', '部门路径无效。', '请传入完整部门路径，例如 --department "心动/技术平台部"。');
  }

  const entries = [];
  const seen = new Set();
  for (const email of emails) addAccessEntry(entries, seen, 'email', email);
  for (const department of departments) addAccessEntry(entries, seen, 'department', department);
  if (requireEntry && entries.length === 0) {
    throw usageError('ACCESS_ENTRIES_REQUIRED', '缺少授权对象。', '请传入 --email <邮箱> 或 --department <部门路径>。');
  }
  return {
    entries,
    emails: entries.filter((entry) => entry.subjectType === 'email').map((entry) => entry.subjectValue),
    departments: entries.filter((entry) => entry.subjectType === 'department').map((entry) => entry.subjectValue),
  };
}

function addAccessEntry(entries, seen, subjectType, subjectValue) {
  const key = `${subjectType}:${subjectValue}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push({ subjectType, subjectValue });
}

function normalizeRepeatedFlag(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

function normalizeDepartmentPath(value) {
  const raw = String(value || '').trim();
  if (!raw || hasControlCharacter(raw)) return '';
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const normalized = parts.join('/');
  if (normalized.length > 256 || parts.some((part) => part.length > 80)) return '';
  return normalized;
}

function hasControlCharacter(value) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function readSiteVisibility(site) {
  return site?.route?.visibility || site?.defaultVisibility || null;
}

function summarizeAccessEntries(aclEntries = []) {
  const emails = [];
  const departments = [];
  const seen = new Set();
  for (const entry of aclEntries) {
    if (!entry || entry.effect !== 'allow') continue;
    const key = `${entry.subjectType}:${entry.subjectValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.subjectType === 'email') emails.push(entry.subjectValue);
    if (entry.subjectType === 'department') departments.push(entry.subjectValue);
  }
  return { emails, departments };
}

function firstAclSetAction(siteSlug, requested) {
  const email = requested.emails[0];
  if (email) return `请先运行 pages access set ${siteSlug} --visibility acl --email ${email}。`;
  const department = requested.departments[0];
  if (department) return `请先运行 pages access set ${siteSlug} --visibility acl --department "${department}"。`;
  return `请先运行 pages access set ${siteSlug} --visibility acl --email user@xd.com。`;
}

function outputAccessResult(parsed, context, payload) {
  if (outputJsonResult(parsed, context, payload)) return 0;
  context.output(`站点名：${payload.site}`);
  context.output(`访问范围：${payload.visibility}`);
  context.output(`邮箱：${payload.emails.length ? payload.emails.join(', ') : '-'}`);
  context.output(`部门：${payload.departments.length ? payload.departments.join(', ') : '-'}`);
  return 0;
}

function assertNoPositionals(parsed, code, message) {
  if (parsed.positional.length > 0) throw usageError(code, message, '运行 pages help 查看用法。');
}

function rejectRemovedProjectFlags(parsed) {
  if (parsed.flags.slug || parsed.flags.site || parsed.flags.saveConfig) {
    throw usageError(
      'OPTION_UNSUPPORTED',
      '该参数不再支持。',
      '请使用位置参数：pages deploy <目录> <站点名>；配置文件请显式使用 --config <file>。'
    );
  }
}

function assertAccessKeyNotUsed(parsed) {
  if (parsed.flags.accessKey) {
    throw usageError(
      'ACCESS_KEY_NOT_USED',
      '当前命令不会使用 access key。',
      '请只在 login、deploy、status、sites、access、rollback 或 auth whoami 等需要访问 API 的命令中传 --access-key。'
    );
  }
}

function nextIdempotencyKey(context) {
  if (typeof context.idempotencyKey === 'function') return context.idempotencyKey();
  return `cli_${randomUUID()}`;
}

function outputJsonResult(parsed, context, payload) {
  if (!parsed.flags.json) return false;
  context.output(JSON.stringify({ ok: true, schemaVersion: 1, ...payload }));
  return true;
}

function outputHelp(parsed, output) {
  const topic = parsed.command === 'help' ? parsed.positional[0] : parsed.command;
  if (parsed.flags.json) {
    output(JSON.stringify({ ok: true, schemaVersion: 1, help: helpJson(topic || 'overview') }));
    return;
  }
  output(helpText(topic || 'overview'));
}

function helpText(topic) {
  if (topic === 'deploy') {
    return `用法：pages deploy <目录> <站点名> [选项]
      pages deploy --config <file> [选项]

发布 static 站点、SPA 或自定义 Worker 到 XD Pages。

选项：
  --env <production|staging>                目标环境；默认 production。
  --visibility <internal|org|acl|owner|disabled>
                                            创建站点时的初始可见性；默认 org。
  --artifact-kind <static|spa|worker>       覆盖 artifact 类型自动识别。
  --access-key <key>                        只在本次命令中使用的 access key，不写入本地。
  --config <file>                           一次性读取发布参数，不自动发现、不写回。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

示例：
  pages deploy ./dist demo --visibility org
  pages deploy ./dist demo --env staging --access-key <access-key> --json
  pages deploy --config pages.config.json

说明：
  站点名使用位置参数；CLI 不读取隐藏项目绑定文件。
  --config 文件只保存非敏感发布参数，例如 environment、site、dir、visibility、artifactKind。
  CLI 不暴露底层执行平台细节。`;
  }
  if (topic === 'login' || topic === 'auth') {
    return `用法：pages login [选项]
      pages auth login [选项]
      pages auth status [选项]
      pages auth whoami [选项]
      pages auth logout [选项]

登录、查看或退出 XD Pages CLI。

选项：
  --env <production|staging>                目标环境；默认 production。
  --access-key <key>                        显式保存已有 access key，保存前会先校验 whoami。
  --no-open                                 只打印浏览器地址，不自动打开。
  --json                                    输出稳定 JSON，不输出 secret。
  --help                                    显示帮助。`;
  }
  if (topic === 'status') {
    return `用法：pages status <站点名> [选项]

查看站点状态。

选项：
  --env <production|staging>                目标环境。
  --deployment <deployment_id>              按部署 ID 查看部署状态。
  --access-key <key>                        只在本次命令中使用的 access key。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'sites') {
    return `用法：pages sites list [选项]
      pages sites info <站点名> [选项]

查看站点列表或站点详情。

选项：
  --env <production|staging>                目标环境。
  --access-key <key>                        只在本次命令中使用的 access key。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'access') {
    return `用法：pages access get <站点名> [选项]
      pages access set <站点名> --visibility <范围> [--email <邮箱>] [--department <部门路径>]
      pages access grant <站点名> [--email <邮箱>] [--department <部门路径>]
      pages access revoke <站点名> [--email <邮箱>] [--department <部门路径>]

查看或调整站点访问范围。

访问范围：
  internal   公司网络内免登录访问。
  org        公司网络内，需公司 SSO active 用户。
  acl        公司网络内，需命中邮箱或部门授权；owner 隐式可访问。
  owner      公司网络内，仅 active owner 可访问。
  disabled   暂停访问。

选项：
  --env <production|staging>                目标环境。
  --visibility <internal|org|acl|owner|disabled>
                                            set 命令使用；设置站点访问范围。
  --email <邮箱>                            可重复传入；acl 访问范围下授权邮箱。
  --department <部门路径>                   可重复传入；acl 访问范围下授权部门及子部门。
  --access-key <key>                        只在本次命令中使用的 access key。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

示例：
  pages access get demo
  pages access set demo --visibility acl --email user@xd.com --department "心动/技术平台部"
  pages access grant demo --email another@xd.com
  pages access revoke demo --department "心动/技术平台部"`;
  }
  if (topic === 'rollback') {
    return `用法：pages rollback <站点名> <version-id> [选项]

回滚站点到一个已存在的不可变版本。普通 Worker slot 站点如果服务端不支持回滚，命令会返回可操作错误。

选项：
  --env <production|staging>                目标环境。
  --access-key <key>                        只在本次命令中使用的 access key。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'open') {
    return `用法：pages open <站点名> [选项]

打开或打印站点地址。

选项：
  --env <production|staging>                目标环境。
  --print                                   只打印 URL，不打开浏览器。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'env') {
    return `用法：pages env [current|list|use] [选项]

管理本地 CLI 环境选择。

命令：
  pages env
  pages env current
  pages env list
  pages env use <production|staging>

选项：
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  return `用法：pages <命令> [选项]

命令：
  login       通过浏览器 SSO 登录，或显式保存 access key。
  auth        查看登录状态、whoami 或退出登录。
  deploy      发布 static 站点、SPA 或自定义 Worker。
  status      查看站点或部署状态。
  sites       查看站点列表或详情。
  rollback    回滚到不可变版本 ID。
  access      查看或调整站点访问范围。
  open        打开或打印站点地址。
  env         查看或切换环境。

全局选项：
  --env <production|staging>                目标环境。
  --access-key <key>                        API 命令的一次性 access key。
  --json                                    在支持的命令中输出稳定 JSON，适合 AI agent 和 CI。
  --help, -h                                显示帮助。
  --version, -v                             显示 CLI 版本。

查看某个命令的参数：
  pages help deploy`;
}

function helpJson(topic) {
  return {
    topic,
    commands: ['login', 'auth', 'deploy', 'status', 'sites', 'rollback', 'access', 'open', 'env'],
    commandHelp: 'pages help <命令>',
    jsonOutput: '使用 --json 输出稳定机器可读结果。CLI 不会输出 secret。',
  };
}

function usageError(code, message, action) {
  const error = new Error(message);
  error.code = code;
  error.action = action;
  return error;
}

async function readCliVersion() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return packageJson.version || 'unknown';
}

function createOutput(stdout) {
  return (line) => {
    if (typeof stdout?.write === 'function') stdout.write(`${line}\n`);
  };
}

async function defaultOpenUrl(url) {
  const { execFile } = await import('node:child_process');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}

export function listFixedEnvironments() {
  return Object.keys(FIXED_ENVIRONMENTS);
}
