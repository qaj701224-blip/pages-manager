import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseArgs } from './args.js';
import { createApiClient } from './api-client.js';
import { createUploadPlan, detectPublishTarget } from './artifact.js';
import { readCommandConfig } from './command-config.js';
import { FIXED_ENVIRONMENTS, readCliConfig } from './config.js';
import { loginWithAccessKey, loginWithBrowser } from './login.js';
import { loadProfile, resolveProfileDir, saveProfile as saveProfileFile } from './profile.js';
import { createSecretStore } from './secret-store.js';

const VALID_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const USER_ENVIRONMENTS = ['production', 'staging'];
const HELP_FLAGS = new Set(['help', 'json', 'token', 'accessKey']);
const VERSION_FLAGS = new Set(['help', 'token', 'accessKey']);
const LOGIN_FLAGS = new Set(['env', 'token', 'accessKey', 'noOpen', 'json', 'help']);
const DEPLOY_FLAGS = new Set([
  'env',
  'visibility',
  'fallback',
  'assets',
  'workerEntry',
  'dryRun',
  'token',
  'accessKey',
  'config',
  'json',
  'help',
  'slug',
  'site',
  'saveConfig',
]);
const DETECT_FLAGS = new Set(['config', 'fallback', 'workerEntry', 'json', 'help']);
const API_READ_FLAGS = new Set(['env', 'token', 'accessKey', 'json', 'help']);
const SECRETS_FLAGS = new Set(['env', 'token', 'accessKey', 'stdin', 'json', 'help']);
const SITES_FLAGS = new Set(['env', 'token', 'accessKey', 'json', 'help', 'details']);
const AUTH_ENV_FLAGS = new Set(['env', 'json', 'help', 'token', 'accessKey']);
const STATUS_FLAGS = new Set(['env', 'deployment', 'token', 'accessKey', 'json', 'help']);
const OPEN_FLAGS = new Set(['env', 'print', 'json', 'help', 'token', 'accessKey']);
const ACCESS_FLAGS = new Set(['env', 'visibility', 'email', 'department', 'token', 'accessKey', 'json', 'help']);
const ENV_FLAGS = new Set(['json', 'help', 'token', 'accessKey']);
const DEPRECATED_HIDDEN_TOKEN_FLAGS = new Set(['accessKey']);

export async function executeCommand(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  validateCommandUsage(parsed);
  const output = options.output || createOutput(options.stdout);
  if (parsed.command === 'help' || parsed.flags.help) {
    assertTokenNotUsed(parsed);
    outputHelp(parsed, output);
    return 0;
  }
  if (parsed.command === 'version') {
    assertTokenNotUsed(parsed);
    assertNoPositionals(parsed, 'VERSION_USAGE_INVALID', 'xd-cell version 不接受位置参数。');
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
    case 'whoami':
      return runWhoami(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'logout':
      return runAuthLogout(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'deploy':
      return runDeploy(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'detect':
      return runDetect(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'secrets':
      return runSecrets(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'status':
      return runStatus(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'open':
      return runOpen(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'sites':
      return runSites(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'access':
      return runAccess(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'env':
      return runEnv(parsed, { ...options, cwd, env, profileDir, profile, output });
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
    '请使用 xd-cell auth login、xd-cell auth status、xd-cell auth whoami 或 xd-cell auth logout。'
  );
}

async function runLogin(parsed, context) {
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

async function runAuthStatus(parsed, context) {
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

async function runWhoami(parsed, context) {
  assertNoPositionals(parsed, 'AUTH_WHOAMI_USAGE_INVALID', 'xd-cell auth whoami 不接受位置参数。');
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const result = await createClient(config, credential, context).requestApi('GET', '/.xd-pages/api/auth/whoami');
  if (outputJsonResult(parsed, context, result)) return 0;
  context.output(JSON.stringify(result));
  return 0;
}

async function runAuthLogout(parsed, context) {
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

async function runDetect(parsed, context) {
  rejectPublicFallbackFlag(parsed);
  if (parsed.positional.length > 1) {
    throw usageError('DETECT_USAGE_INVALID', 'detect 参数过多。', '请使用 xd-cell detect <entry>。');
  }
  const commandConfig = await readCommandConfig(parsed.flags.config, { cwd: context.cwd, discover: !parsed.flags.config });
  const deployConfig = await resolveDeployConfig(parsed, commandConfig, context, { requireSite: false, defaultEntry: '.' });
  const decision = await detectPublishTarget(deployConfig.targetPath, {
    requestedFallback: deployConfig.requestedFallback,
    workerEntry: deployConfig.workerEntry,
    assetsPath: deployConfig.assetsPath,
  });
  const payload = preflightEnvelope({
    mode: 'detect',
    configPath: deployConfig.configPath,
    target: deployTargetEnvelope(deployConfig),
    decision,
    checks: {
      localDetectionPassed: true,
      packageChecked: false,
      canPackage: null,
      remoteChecked: false,
      canDeploy: null,
      canDeployScope: 'none',
    },
    sideEffects: { willDeploy: false },
  });
  if (parsed.flags.json) {
    context.output(JSON.stringify(payload));
    return 0;
  }
  outputHumanDetection(context.output, deployConfig.entry, decision);
  return 0;
}

async function runDeploy(parsed, context) {
  rejectRemovedProjectFlags(parsed);
  rejectPublicFallbackFlag(parsed);
  const commandConfig = await readCommandConfig(parsed.flags.config, { cwd: context.cwd, discover: !parsed.flags.config });
  const config = readConfigForCommand(parsed, { ...context, commandConfig }, { allowHiddenEnvironmentSources: true });
  if (parsed.positional.length > 2) throw usageError('USAGE_INVALID', 'deploy 参数过多。', '请使用 xd-cell deploy <目录> <站点名>。');
  const deployConfig = await resolveDeployConfig(parsed, commandConfig, context, { requireSite: true });
  const { siteSlug } = deployConfig;
  outputProgress(parsed, context, '检查发布目录...');
  const decision = await detectPublishTarget(deployConfig.targetPath, {
    requestedFallback: deployConfig.requestedFallback,
    workerEntry: deployConfig.workerEntry,
    assetsPath: deployConfig.assetsPath,
  });
  const runtime = runtimeConfigForDecision(deployConfig, decision);
  const uploadPlan = await createUploadPlan(deployConfig.targetPath, decision);
  outputProgress(parsed, context, `检查发布目录完成：${uploadPlan.fileCount} files / ${formatBytes(uploadPlan.sizeBytes)}`);
  outputProgress(parsed, context, `识别结果：${humanDeploymentLabel(decision)}`);
  outputProgress(parsed, context, `找不到文件时：${humanFallbackLabel(decision.resolvedFallback)}`);
  if (parsed.flags.dryRun) {
    const payload = preflightEnvelope({
      mode: 'dry-run',
      site: siteSlug,
      configPath: deployConfig.configPath,
      target: deployTargetEnvelope(deployConfig),
      decision,
      uploadPlan,
      checks: {
        localDetectionPassed: true,
        packageChecked: true,
        canPackage: true,
        remoteChecked: false,
        canDeploy: null,
        canDeployScope: 'local',
      },
      sideEffects: {
        willDeploy: false,
        siteCreated: false,
        deploymentCreated: false,
        filesUploaded: false,
        routeChanged: false,
      },
      runtime,
    });
    if (parsed.flags.json) {
      context.output(JSON.stringify(payload));
      return 0;
    }
    outputHumanDryRun(context.output, deployConfig.entry, siteSlug, decision, uploadPlan);
    return 0;
  }

  outputProgress(parsed, context, '准备凭证...');
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  const requestedVisibility = parsed.flags.visibility || commandConfig?.visibility;
  if (requestedVisibility && !VALID_VISIBILITIES.has(requestedVisibility)) {
    throw usageError('SITE_VISIBILITY_INVALID', '站点可见性无效。', '请使用 internal、org、acl、owner 或 disabled。');
  }

  let siteCreated = false;
  const actorInfo = await readCredentialActor(client, credential);
  if (actorInfo?.type !== 'access_key') {
    outputProgress(parsed, context, '准备站点...');
    const visibility = requestedVisibility || 'org';
    try {
      await client.requestApi('POST', '/.xd-pages/api/sites', { slug: siteSlug, visibility });
      siteCreated = true;
    } catch (error) {
      if (error?.code !== 'SITE_SLUG_CONFLICT') throw error;
    }
  }

  outputProgress(parsed, context, '上传并发布...');
  const deployed = await client.requestApiForm(
    'POST',
    '/.xd-pages/api/deployments',
    buildPublishPlanDeploymentForm({
      siteSlug,
      uploadPlan,
      vars: runtime.varsObject,
      varsProvided: runtime.varsProvided,
    }),
    { idempotencyKey: nextIdempotencyKey(context) }
  );

  const url = deployed.route?.hostname ? `https://${deployed.route.hostname}` : siteUrlForSlug(siteSlug, config);
  const finalDecision = decisionSummaryFromResponse(deployed.decision) || decisionSummary(decision);
  if (
    outputJsonResult(parsed, context, {
      type: 'deploy',
      mode: 'deploy',
      environment: config.environment,
      site: siteSlug,
      configPath: deployConfig.configPath,
      target: deployTargetEnvelope(deployConfig),
      decision: finalDecision,
      uploadPlanSummary: uploadPlanSummary(uploadPlan),
      checks: {
        localDetectionPassed: true,
        packageChecked: true,
        canPackage: true,
        remoteChecked: true,
        canDeploy: true,
        canDeployScope: 'remote-deploy',
      },
      sideEffects: {
        willDeploy: true,
        siteCreated,
        deploymentCreated: true,
        filesUploaded: uploadPlan.fileCount > 0 || uploadPlan.workerModules.length > 0,
        routeChanged: true,
      },
      signals: decision.signals || [],
      diagnostics: {
        warnings: (decision.diagnostics || []).filter((diagnostic) => diagnostic.severity !== 'error'),
        errors: (decision.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error'),
      },
      runtime: runtimeEnvelope(runtime),
      deployment: deployed.deployment || null,
      version: deployed.version || null,
      route: deployed.route || null,
      url,
    })
  ) {
    return 0;
  }
  context.output(`站点名：${siteSlug}`);
  context.output(`识别结果：${humanDeploymentLabel(decision)}`);
  context.output(`找不到文件时：${humanFallbackLabel(decision.resolvedFallback)}`);
  context.output(`部署：${deployed.deployment?.id || 'created'} ${deployed.deployment?.status || ''}`.trim());
  if (url) context.output(`发布完成：${url}`);
  return 0;
}

async function runEnv(parsed, context) {
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

function buildPublishPlanDeploymentForm({ siteSlug, uploadPlan, vars = {}, varsProvided = false }) {
  const form = new FormData();
  const metadata = {
    schemaVersion: 1,
    siteSlug,
    requestedFallback: uploadPlan.publishPlan.requestedFallback,
    source: 'cli',
    contentHash: uploadPlan.contentHash,
    publishPlan: uploadPlan.publishPlan,
    assetManifest: uploadPlan.assetManifest,
    workerMainModuleName: uploadPlan.workerMainModuleName,
    workerModules: uploadPlan.workerModules.map(({ moduleName, partName, hash, size, contentType }) => ({
      moduleName,
      partName,
      hash,
      size,
      contentType,
    })),
    controlSignals: uploadPlan.controlSignals,
  };
  if (varsProvided) metadata.vars = vars;
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const file of uploadPlan.assetFiles) {
    form.set(file.partName, new Blob([file.bytes], { type: file.contentType }), file.relativePath);
  }
  for (const module of uploadPlan.workerModules) {
    form.set(module.partName, new Blob([module.content], { type: module.contentType }), module.moduleName);
  }
  return form;
}

async function resolveDeployConfig(parsed, commandConfig, context, { requireSite, defaultEntry = null } = {}) {
  const positionalEntry = parsed.positional[0];
  const positionalSite = parsed.positional[1];
  const configDir = commandConfig?.configDir || context.cwd;
  const configMain = commandConfig?.main || null;
  const configAssets = commandConfig?.assets?.directory || null;
  const hasWorkerConfig = Boolean(configMain);
  const configEntry = configMain || configAssets || defaultEntry;
  const entry = positionalEntry || configEntry;
  const siteSlug = normalizeSiteSlug(positionalSite || commandConfig?.name);
  if (!entry) {
    throw usageError(
      'DIR_REQUIRED',
      '缺少发布入口。',
      '请使用 xd-cell deploy <entry> <site>，或在 xd-cell.config.json / --config <file> 中配置 main 或 assets.directory。'
    );
  }
  if (requireSite && !siteSlug) {
    throw usageError(
      'SITE_REQUIRED',
      '缺少站点名。',
      '请使用 xd-cell deploy <entry> <site>，或在 xd-cell.config.json / --config <file> 中配置 name。'
    );
  }

  const entryBaseDir = positionalEntry || !commandConfig ? context.cwd : configDir;
  const targetPath = path.resolve(entryBaseDir, entry);
  const positionalEntryStats = positionalEntry && configAssets && !parsed.flags.assets ? await stat(targetPath) : null;
  const positionalEntryIsFile = Boolean(positionalEntryStats?.isFile());
  const shouldUseConfigAssets = !positionalEntry || positionalEntryIsFile;
  const cliAssets = parsed.flags.assets || null;
  const assetsEntry = cliAssets || (shouldUseConfigAssets ? configAssets : null) || null;
  const assetsBaseDir = cliAssets || !commandConfig ? context.cwd : configDir;
  const assetsPath = assetsEntry ? path.resolve(assetsBaseDir, assetsEntry) : null;
  const requestedFallback = commandConfig?.assets?.not_found_handling || 'none';
  const workerEntry =
    hasWorkerConfig && !positionalEntry
      ? entry.replaceAll('\\', '/').replace(/^\.\/+/, '')
      : positionalEntryIsFile && assetsEntry
        ? path.basename(targetPath)
        : null;
  return {
    entry,
    siteSlug,
    targetPath,
    assets: assetsEntry,
    assetsPath,
    requestedFallback,
    workerEntry: parsed.flags.workerEntry || workerEntry,
    vars: commandConfig?.vars || {},
    varsProvided: Boolean(commandConfig && Object.prototype.hasOwnProperty.call(commandConfig, 'vars')),
    configPath: commandConfig?.configPath || null,
  };
}

function deployTargetEnvelope(deployConfig) {
  return {
    source: deployConfig.entry,
    kind: 'entry',
    requestedFallback: deployConfig.requestedFallback,
    workerEntry: deployConfig.workerEntry,
    ...(deployConfig.assets ? { assets: deployConfig.assets } : {}),
  };
}

async function readCredentialActor(client, credential) {
  if (credential.type !== 'bearer') return credential.type === 'access_key' ? { type: 'access_key' } : { type: 'user' };
  try {
    const whoami = await client.requestApi('GET', '/.xd-pages/api/auth/whoami');
    return whoami?.actor || null;
  } catch {
    return null;
  }
}

function preflightEnvelope({ mode, site, configPath, target, decision, uploadPlan, checks, sideEffects, runtime = null }) {
  const payload = {
    ok: true,
    schemaVersion: 1,
    type: 'preflight',
    mode,
    ...(site ? { site } : {}),
    ...(configPath ? { configPath } : {}),
    target,
    decision: decisionSummary(decision),
    checks,
    sideEffects,
    signals: decision.signals || [],
    diagnostics: {
      warnings: (decision.diagnostics || []).filter((diagnostic) => diagnostic.severity !== 'error'),
      errors: (decision.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error'),
    },
  };
  if (uploadPlan) {
    payload.uploadPlanSummary = uploadPlanSummary(uploadPlan);
  }
  if (runtime) payload.runtime = runtimeEnvelope(runtime);
  return payload;
}

function runtimeConfigForDecision(deployConfig, decision) {
  const vars = deployConfig.vars || {};
  const ignoredVars = deployConfig.varsProvided && !decisionRequiresWorker(decision) ? Object.keys(vars).sort() : [];
  return {
    varsObject: ignoredVars.length ? {} : vars,
    vars: ignoredVars.length ? [] : Object.keys(vars).sort(),
    ignoredVars,
    varsProvided: deployConfig.varsProvided && decisionRequiresWorker(decision),
  };
}

function runtimeEnvelope(runtime) {
  return {
    vars: runtime.vars,
    ...(runtime.ignoredVars.length ? { ignoredVars: runtime.ignoredVars } : {}),
  };
}

function decisionRequiresWorker(decision) {
  return decision?.deploymentShape === 'worker-only' || decision?.deploymentShape === 'worker-with-assets';
}

function uploadPlanSummary(uploadPlan) {
  return {
    contentHash: uploadPlan.contentHash,
    fileCount: uploadPlan.fileCount,
    sizeBytes: uploadPlan.sizeBytes,
    assetControlFilesExcluded: (uploadPlan.controlSignals || []).map((signal) => signal.path),
  };
}

function decisionSummary(decision) {
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
    confidence: decision.confidence,
    source: decision.source,
  };
}

function decisionSummaryFromResponse(decision) {
  if (!decision) return null;
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
    confidence: undefined,
    source: 'api',
  };
}

async function runStatus(parsed, context) {
  if (!parsed.flags.deployment && parsed.positional.length === 0) return runAuthStatus(parsed, context);

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

  const site = readSingleSiteArg(parsed, 'STATUS_USAGE_INVALID', '请使用 xd-cell status <站点名>。');
  const result = await readSiteBySlug(client, site);
  if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
  outputSiteStatus(context.output, config.environment, result.site);
  return 0;
}

async function runOpen(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const site = readSingleSiteArg(parsed, 'OPEN_USAGE_INVALID', '请使用 xd-cell open <站点名>。');
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);
  const result = await readSiteBySlug(client, site);
  const url = siteUrlForOpen(result.site, config);
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
    assertNoPositionals(child, 'SITES_LIST_USAGE_INVALID', 'xd-cell sites list 不接受位置参数。');
    const result = await client.requestApi('GET', '/.xd-pages/api/sites');
    const payload = parsed.flags.details
      ? { environment: config.environment, ...result }
      : { environment: config.environment, sites: summarizeSites(result.sites || []) };
    if (outputJsonResult(parsed, context, payload)) return 0;
    if (parsed.flags.details) {
      context.output(formatJson(payload));
    } else {
      outputSitesSummary(context.output, payload.sites);
    }
    return 0;
  }

  if (subcommand === 'info') {
    const site = readSingleSiteArg(child, 'SITES_INFO_USAGE_INVALID', '请使用 xd-cell sites info <站点名>。');
    const result = await readSiteBySlug(client, site);
    if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
    outputSiteInfo(context.output, config.environment, result.site);
    return 0;
  }

  throw usageError('SITES_COMMAND_INVALID', 'sites 命令无效。', '请使用 xd-cell sites list 或 xd-cell sites info <站点名>。');
}

async function runAccess(parsed, context) {
  const subcommand = parsed.positional[0] || 'get';
  const child = { ...parsed, positional: parsed.positional.slice(1) };
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  if (subcommand === 'get') {
    assertFlagsAbsent(parsed, ['visibility', 'email', 'department'], 'ACCESS_GET_USAGE_INVALID', 'access get 不接受访问范围设置参数。');
    const siteSlug = readSingleSiteArg(child, 'ACCESS_GET_USAGE_INVALID', '请使用 xd-cell access get <站点名>。');
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
    const siteSlug = readSingleSiteArg(child, 'ACCESS_SET_USAGE_INVALID', '请使用 xd-cell access set <站点名> --visibility <范围>。');
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
      `请使用 xd-cell access ${subcommand} <站点名> --email <邮箱> 或 --department <部门路径>。`
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
    '请使用 xd-cell access get、set、grant 或 revoke。'
  );
}

async function runSecrets(parsed, context) {
  const subcommand = parsed.positional[0];
  if (subcommand === 'put') return runSecretsPut({ ...parsed, positional: parsed.positional.slice(1) }, context);
  if (subcommand === 'delete') return runSecretsDelete({ ...parsed, positional: parsed.positional.slice(1) }, context);
  throw usageError(
    'SECRETS_COMMAND_INVALID',
    'secrets 命令无效。',
    '请使用 xd-cell secrets put <site> <name> 或 xd-cell secrets delete <site> <name>。'
  );
}

async function runSecretsPut(parsed, context) {
  if (parsed.positional.length !== 2) {
    throw usageError(
      'SECRETS_PUT_USAGE_INVALID',
      'secrets put 参数无效。',
      '请使用 xd-cell secrets put <site> <name>，并通过隐藏输入或 --stdin 提供 value。'
    );
  }
  const site = normalizeSiteSlug(parsed.positional[0]);
  if (!site) throw usageError('SITE_REQUIRED', '缺少站点名。', '请使用 xd-cell secrets put <site> <name>。');
  const name = normalizeSecretName(parsed.positional[1]);
  const value = await readSecretValue(parsed, context);
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);
  await client.requestApi('PUT', `/.xd-pages/api/sites/${encodeURIComponent(site)}/secrets`, { name, value });
  if (outputJsonResult(parsed, context, {
    type: 'secret',
    environment: config.environment,
    site,
    name,
    operation: 'put',
  })) {
    return 0;
  }
  context.output(`已保存 secret：${site}/${name}`);
  return 0;
}

async function runSecretsDelete(parsed, context) {
  if (parsed.positional.length !== 2) {
    throw usageError('SECRETS_DELETE_USAGE_INVALID', 'secrets delete 参数无效。', '请使用 xd-cell secrets delete <site> <name>。');
  }
  const site = normalizeSiteSlug(parsed.positional[0]);
  if (!site) throw usageError('SITE_REQUIRED', '缺少站点名。', '请使用 xd-cell secrets delete <site> <name>。');
  const name = normalizeSecretName(parsed.positional[1]);
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);
  await client.requestApi('DELETE', `/.xd-pages/api/sites/${encodeURIComponent(site)}/secrets`, { name });
  if (outputJsonResult(parsed, context, {
    type: 'secret',
    environment: config.environment,
    site,
    name,
    operation: 'delete',
  })) {
    return 0;
  }
  context.output(`已删除 secret：${site}/${name}`);
  context.output('该操作只影响后续 Worker 发布；已经物化到当前运行 Worker 的 secret 不会被立即撤销。');
  return 0;
}

async function readSecretValue(parsed, context) {
  if (parsed.flags.stdin) {
    const text = await readAllStdin(context.stdin);
    const value = text.replace(/\r?\n$/, '');
    if (!value) throw usageError('SECRET_VALUE_REQUIRED', '缺少 secret value。', '请通过 stdin 传入非空 secret value。');
    return value;
  }
  if (!context.stdin?.isTTY && !process.stdin.isTTY) {
    throw usageError('SECRET_STDIN_REQUIRED', '当前环境无法隐藏输入 secret。', '请使用 --stdin 从标准输入传入。');
  }
  if (typeof context.readSecret === 'function') return context.readSecret('Secret value: ');
  throw usageError('SECRET_STDIN_REQUIRED', '当前环境无法隐藏输入 secret。', '请使用 --stdin 从标准输入传入。');
}

async function readAllStdin(stdin) {
  if (stdin && typeof stdin.text === 'function') return stdin.text();
  const stream = stdin || process.stdin;
  let output = '';
  for await (const chunk of stream) output += chunk;
  return output;
}

function validateCommandUsage(parsed) {
  if (parsed.command === 'rollback') throw unsupportedRollbackError();
  const allowed = allowedFlagsForCommand(parsed);
  if (allowed) assertOnlyAllowedFlags(parsed, allowed);
  if (parsed.command === 'help' && parsed.positional.length > 1) {
    throw usageError('HELP_USAGE_INVALID', 'help 参数无效。', '请使用 xd-cell help 或 xd-cell help <命令>。');
  }
}

function allowedFlagsForCommand(parsed) {
  if (parsed.command === 'help') return HELP_FLAGS;
  if (parsed.command === 'version') return VERSION_FLAGS;
  if (parsed.command === 'login') return LOGIN_FLAGS;
  if (parsed.command === 'deploy') return DEPLOY_FLAGS;
  if (parsed.command === 'detect') return DETECT_FLAGS;
  if (parsed.command === 'secrets') return SECRETS_FLAGS;
  if (parsed.command === 'whoami') return API_READ_FLAGS;
  if (parsed.command === 'logout') return AUTH_ENV_FLAGS;
  if (parsed.command === 'status') return STATUS_FLAGS;
  if (parsed.command === 'open') return OPEN_FLAGS;
  if (parsed.command === 'sites') return SITES_FLAGS;
  if (parsed.command === 'access') return ACCESS_FLAGS;
  if (parsed.command === 'auth') return allowedAuthFlags(parsed);
  if (parsed.command === 'env') return ENV_FLAGS;
  return null;
}

function allowedAuthFlags(parsed) {
  const subcommand = parsed.positional[0] || 'status';
  if (subcommand === 'login') return LOGIN_FLAGS;
  if (subcommand === 'status' || subcommand === 'logout') return AUTH_ENV_FLAGS;
  if (subcommand === 'whoami') return API_READ_FLAGS;
  return API_READ_FLAGS;
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
      throw usageError(code, message, '请运行 xd-cell help access 查看用法。');
    }
  }
}

function displayFlagName(flag) {
  return flag.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function helpActionForCommand(command) {
  if (command && command !== 'help' && command !== 'version') return `请运行 xd-cell help ${command} 查看可用选项。`;
  return '请运行 xd-cell help 查看可用选项。';
}

function unsupportedRollbackError() {
  return usageError(
    'COMMAND_UNSUPPORTED',
    '当前 CLI 不支持 rollback 命令。',
    '请使用 xd-cell status <site> 查看当前版本；如需回滚请联系平台维护者。'
  );
}

function unsupportedEnvError() {
  return usageError(
    'COMMAND_UNSUPPORTED',
    '当前 CLI 不支持 env 命令。',
    '普通发布默认使用 production；内部验证请使用维护者流程。'
  );
}

async function readSiteBySlug(client, slug) {
  const result = await client.requestApi('GET', '/.xd-pages/api/sites');
  const site = Array.isArray(result?.sites) ? result.sites.find((candidate) => candidate.slug === slug) : null;
  if (!site) {
    const suggestion = suggestClosestSlug(slug, result?.sites || []);
    throw usageError(
      'SITE_NOT_FOUND',
      `未找到站点：${slug}`,
      suggestion
        ? `未找到 ${slug}。你是不是想查看 ${suggestion}？`
        : '请确认站点名和站点权限；如果使用 API token，请确认它绑定的是这个站点。'
    );
  }
  return { site };
}

function readConfigForCommand(parsed, context, options = {}) {
  const requestedEnvironment =
    parsed.flags.env ||
    context.commandConfig?.environment ||
    (options.allowHiddenEnvironmentSources
      ? context.env.PAGES_CLI_ENV || context.profile?.activeEnvironment || context.env.PAGES_ENV
      : null) ||
    'production';
  if (parsed.flags.env) readHiddenEnvironment(parsed.flags.env);
  if (options.allowHiddenEnvironmentSources && !context.commandConfig?.environment) {
    readHiddenEnvironment(requestedEnvironment);
  }
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

function readHiddenEnvironment(value) {
  if (USER_ENVIRONMENTS.includes(value)) return value;
  throw usageError('ENVIRONMENT_INVALID', '环境无效。', '请使用 production 或 staging。');
}

function readOneShotToken(parsed) {
  if (parsed.flags.token) return parsed.flags.token;
  // Kept only for old scripts. Public help and docs teach --token.
  for (const flag of DEPRECATED_HIDDEN_TOKEN_FLAGS) {
    if (parsed.flags[flag]) return parsed.flags[flag];
  }
  return null;
}

async function resolveCredential(environment, context, parsed) {
  const token = readOneShotToken(parsed);
  if (token) {
    return {
      type: 'bearer',
      value: token,
    };
  }
  if (context.env.XD_CELL_API_TOKEN) {
    return {
      type: 'bearer',
      value: context.env.XD_CELL_API_TOKEN,
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

function siteUrlForOpen(site, config) {
  if (site?.url) return site.url;
  if (site?.route?.hostname) return `https://${site.route.hostname}`;
  return siteUrlForSlug(site?.slug, config);
}

function normalizeSiteSlug(value) {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return slug || null;
}

function normalizeSecretName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
    throw usageError('SECRET_NAME_INVALID', 'secret 名称无效。', '请使用 Worker binding 名称，例如 API_TOKEN。');
  }
  if (
    name === 'ASSETS' ||
    name.startsWith('XD_') ||
    name.startsWith('XD_CELL_') ||
    name.startsWith('XD_PAGES_') ||
    name.startsWith('CF_')
  ) {
    throw usageError('SECRET_NAME_RESERVED', 'secret 名称是平台保留名。', '请换一个业务 secret 名称。');
  }
  return name;
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

function summarizeSites(sites = []) {
  return sites.map((site) => ({
    site: site.slug,
    environment: site.environment,
    visibility: readSiteVisibility(site),
    status: site?.route?.status || 'created',
    url: site.url || (site?.route?.hostname ? `https://${site.route.hostname}` : null),
  }));
}

function outputSitesSummary(output, sites) {
  if (!sites.length) {
    output('暂无站点。');
    return;
  }
  output(['站点名', '环境', '访问范围', '状态', 'URL'].join('\t'));
  for (const site of sites) {
    output([site.site, site.environment, site.visibility || '-', site.status || '-', site.url || '-'].join('\t'));
  }
}

function outputSiteInfo(output, environment, site) {
  output(`站点名：${site.slug}`);
  output(`环境：${site.environment || environment}`);
  output(`访问范围：${readSiteVisibility(site) || '-'}`);
  output(`状态：${site?.route?.status || 'created'}`);
  if (site.url || site?.route?.hostname) output(`URL ${site.url || `https://${site.route.hostname}`}`);
  output(`创建时间：${site.createdAt || '-'}`);
  output(`更新时间：${site.updatedAt || '-'}`);
}

function outputSiteStatus(output, environment, site) {
  output(`站点名：${site.slug}`);
  output(`环境：${site.environment || environment}`);
  output(`运行状态：${site?.route?.status || 'created'}`);
  output(`运行时：${site?.route?.runtime || '-'}`);
  output(`访问范围：${readSiteVisibility(site) || '-'}`);
  output(`版本：${site?.route?.activeVersionId || '-'}`);
  if (site.url || site?.route?.hostname) output(`URL ${site.url || `https://${site.route.hostname}`}`);
}

function outputHumanDetection(output, source, decision) {
  output(`发布目录：${source}`);
  output(`识别结果：${humanDeploymentLabel(decision)}`);
  output(`找不到文件时：${humanFallbackLabel(decision.resolvedFallback)}`);
  output(`置信度：${decision.confidence}`);
  for (const diagnostic of decision.diagnostics || []) {
    output(`提示：${diagnostic.message || diagnostic.code}`);
  }
}

function outputHumanDryRun(output, source, site, decision, uploadPlan) {
  output('本地预演，不会创建站点、不会创建 deployment、不会上传文件，也不会检查远端权限或站点名。');
  output(`站点名：${site}`);
  output(`检查发布目录完成：${uploadPlan.fileCount} files / ${formatBytes(uploadPlan.sizeBytes)}`);
  output(`发布目录：${source}`);
  output(`识别结果：${humanDeploymentLabel(decision)}`);
  output(`找不到文件时：${humanFallbackLabel(decision.resolvedFallback)}`);
  output('本地打包预演通过。');
}

function humanDeploymentLabel(decision) {
  if (decision.deploymentShape === 'worker-only') return 'Worker';
  if (decision.deploymentShape === 'worker-with-assets') return 'Worker + 静态资源';
  return '静态资源目录';
}

function humanFallbackLabel(value) {
  if (value === 'index') return '返回 /index.html';
  if (value === 'not-found') return '返回 404.html 或 404';
  if (value === null) return '由 Worker 处理';
  return '平台默认未命中处理';
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function suggestClosestSlug(slug, sites = []) {
  let best = null;
  for (const site of sites) {
    if (!site?.slug) continue;
    const distance = levenshteinDistance(slug, site.slug);
    if (!best || distance < best.distance) best = { slug: site.slug, distance };
  }
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(String(slug || '').length * 0.25));
  return best.distance <= threshold ? best.slug : null;
}

function levenshteinDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
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
  if (email) return `请先运行 xd-cell access set ${siteSlug} --visibility acl --email ${email}。`;
  const department = requested.departments[0];
  if (department) return `请先运行 xd-cell access set ${siteSlug} --visibility acl --department "${department}"。`;
  return `请先运行 xd-cell access set ${siteSlug} --visibility acl --email user@xd.com。`;
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
  if (parsed.positional.length > 0) throw usageError(code, message, '运行 xd-cell help 查看用法。');
}

function rejectRemovedProjectFlags(parsed) {
  if (parsed.flags.slug || parsed.flags.site || parsed.flags.saveConfig) {
    throw usageError(
      'OPTION_UNSUPPORTED',
      '该参数不再支持。',
      '请使用位置参数：xd-cell deploy <entry> <site>；也可以在当前目录放 xd-cell.config.json 或显式传 --config <file>。'
    );
  }
}

function rejectPublicFallbackFlag(parsed) {
  if (parsed.flags.fallback !== undefined) {
    throw usageError(
      'OPTION_UNSUPPORTED',
      'deploy 不再支持 --fallback。',
      '请在 xd-cell.config.json 的 assets.not_found_handling 中设置 none、single-page-application 或 404-page。'
    );
  }
}

function assertTokenNotUsed(parsed) {
  if (readOneShotToken(parsed)) {
    throw usageError(
      'ACCESS_KEY_NOT_USED',
      '当前命令不会使用 token。',
      '请只在 login、deploy、status、sites、access、secrets 或 whoami 等需要访问 API 的命令中传 --token。'
    );
  }
}

function nextIdempotencyKey(context) {
  if (typeof context.idempotencyKey === 'function') return context.idempotencyKey();
  return `cli_${randomUUID()}`;
}

function outputJsonResult(parsed, context, payload) {
  if (!parsed.flags.json) return false;
  context.output(formatJson({ ok: true, schemaVersion: 1, ...payload }));
  return true;
}

function outputProgress(parsed, context, line) {
  if (!parsed.flags.json) context.output(line);
}

function outputHelp(parsed, output) {
  const topic = parsed.command === 'help' ? parsed.positional[0] : parsed.command;
  if (topic === 'rollback') throw unsupportedRollbackError();
  if (topic === 'env') throw unsupportedEnvError();
  if (parsed.flags.json) {
    output(formatJson({ ok: true, schemaVersion: 1, help: helpJson(topic || 'overview') }));
    return;
  }
  output(helpText(topic || 'overview'));
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function helpText(topic) {
  if (topic === 'deploy') {
    return `用法：
  xd-cell deploy <entry> <site> [选项]
  xd-cell deploy [entry] [选项]
      xd-cell deploy --config <file> [选项]

发布业务站点到 XD Cell。
entry 是静态资源目录或 Worker 入口；site 是业务站点名，可由位置参数或 xd-cell.config.json 的 name 提供。
未传 --config 时，CLI 会读取当前目录的 xd-cell.config.json；单个位置参数始终按 entry 解释。

选项：
  --assets <dir>                            Worker 发布时附带静态资源目录。
  --visibility <internal|org|acl|owner|disabled>
                                            创建站点时的初始访问范围；默认 org。
  --dry-run                                 只做本地预演，不创建站点、不上传文件。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --config <file>                           读取发布模板。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

示例：
  xd-cell deploy ./dist demo --visibility org
  xd-cell deploy ./src/index.js demo --assets ./dist
  XD_CELL_API_TOKEN=<token> xd-cell deploy ./dist demo --json
  xd-cell deploy --config xd-cell.config.json

说明：
  xd-cell.config.json 只保存非敏感发布模板字段，例如 name、main、assets.directory、vars、visibility。
  vars 是站点级当前 runtime config；配置省略 vars 会沿用站点当前值，显式 {} 会在下一次 Worker deploy 清空。
  静态资源未命中行为使用 assets.not_found_handling 配置；不提供 --fallback。
  CLI 不暴露底层执行平台细节。`;
  }
  if (topic === 'detect') {
    return `用法：xd-cell detect <entry> [选项]

本地识别发布入口，不登录、不联网、不上传文件。

选项：
  --config <file>                           一次性读取发布参数。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'login' || topic === 'auth') {
    return `用法：xd-cell login [选项]
      xd-cell status [选项]
      xd-cell whoami [选项]
      xd-cell logout [选项]

登录、查看或退出 XD Cell CLI。

选项：
  --token <token>                           显式保存已有站点 access key，保存前会先校验 whoami。
  --no-open                                 只打印浏览器地址，不自动打开。
  --json                                    输出稳定 JSON，不输出 secret。
  --help                                    显示帮助。`;
  }
  if (topic === 'status') {
    return `用法：xd-cell status [站点名] [选项]

查看登录状态、站点状态或部署状态。

选项：
  --deployment <deployment_id>              按部署 ID 查看部署状态。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'whoami') {
    return `用法：xd-cell whoami [选项]

查看当前凭证身份。

选项：
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'logout') {
    return `用法：xd-cell logout [选项]

退出本地登录。

选项：
  --json                                    输出稳定 JSON，不输出 secret。
  --help                                    显示帮助。`;
  }
  if (topic === 'sites') {
    return `用法：xd-cell sites list [选项]
      xd-cell sites info <站点名> [选项]

查看站点列表或站点详情。

选项：
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --details                                 sites list 输出完整站点详情；默认只显示概要。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'secrets') {
    return `用法：
  xd-cell secrets put <site> <name> [选项]
  xd-cell secrets delete <site> <name> [选项]

管理站点级 Worker secret。secret value 不放在位置参数、配置文件或输出里。

选项：
  --stdin                                   从标准输入读取 secret value，适合 CI。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --json                                    输出稳定 JSON，不输出 secret value。
  --help                                    显示帮助。

示例：
  xd-cell secrets put demo API_TOKEN
  echo "$API_TOKEN" | xd-cell secrets put demo API_TOKEN --stdin
  xd-cell secrets delete demo API_TOKEN`;
  }
  if (topic === 'access') {
    return `用法：xd-cell access get <站点名> [选项]
      xd-cell access set <站点名> --visibility <范围> [--email <邮箱>] [--department <部门路径>]
      xd-cell access grant <站点名> [--email <邮箱>] [--department <部门路径>]
      xd-cell access revoke <站点名> [--email <邮箱>] [--department <部门路径>]

查看或调整站点访问范围。

访问范围：
  internal   公司网络内免登录访问。
  org        公司网络内，需公司 SSO active 用户。
  acl        公司网络内，需命中邮箱或部门授权；owner 隐式可访问。
  owner      公司网络内，仅 active owner 可访问。
  disabled   暂停访问。

选项：
  --visibility <internal|org|acl|owner|disabled>
                                            set 命令使用；设置站点访问范围。
  --email <邮箱>                            可重复传入；acl 访问范围下授权邮箱。
  --department <部门路径>                   可重复传入；acl 访问范围下授权部门及子部门。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

示例：
  xd-cell access get demo
  xd-cell access set demo --visibility acl --email user@xd.com --department "心动/技术平台部"
  xd-cell access grant demo --email another@xd.com
  xd-cell access revoke demo --department "心动/技术平台部"`;
  }
  if (topic === 'open') {
    return `用法：xd-cell open <站点名> [选项]

读取站点真实地址后打开或打印，已有历史路由会按平台保存的 URL 打开。

选项：
  --print                                   只打印 URL，不打开浏览器。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  return `用法：xd-cell <命令> [选项]

命令：
  login       通过浏览器 SSO 登录，或保存站点 access key。
  logout      退出本地登录。
  whoami      查看当前凭证身份。
  detect      本地识别发布入口。
  deploy      发布目录到 XD Cell，自动判断发布方式。
  status      查看登录状态、站点或部署状态。
  sites       查看站点列表或详情。
  secrets     管理站点级 Worker secret。
  access      查看或调整站点访问范围。
  open        打开或打印站点地址。

全局选项：
  --token <token>                           API 命令的一次性 API token；也可以设置 XD_CELL_API_TOKEN。
  --json                                    在支持的命令中输出稳定 JSON，适合 AI agent 和 CI。
  --help, -h                                显示帮助。
  --version, -v                             显示 CLI 版本。

查看某个命令的参数：
  xd-cell help deploy`;
}

function helpJson(topic) {
  return {
    topic,
    commands: ['login', 'logout', 'whoami', 'detect', 'deploy', 'status', 'sites', 'secrets', 'access', 'open'],
    commandHelp: 'xd-cell help <命令>',
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
  const packageJson = JSON.parse(await readFirstExistingPackageJson());
  return packageJson.version || 'unknown';
}

async function readFirstExistingPackageJson() {
  const candidates = [new URL('./package.json', import.meta.url), new URL('../package.json', import.meta.url)];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lastError = error;
    }
  }
  throw lastError;
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
