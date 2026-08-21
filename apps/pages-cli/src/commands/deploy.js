import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { createUploadPlan, detectPublishTarget } from '../artifact.js';
import { readCommandConfig } from '../command-config.js';
import {
  VALID_VISIBILITIES,
  createClient,
  normalizeSiteSlug,
  outputJsonResult,
  outputProgress,
  readConfigForCommand,
  resolveCredential,
  siteUrlForSlug,
  usageError,
} from './shared.js';

export async function runDetect(parsed, context) {
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

export async function runDeploy(parsed, context) {
  rejectRemovedProjectFlags(parsed);
  rejectPublicFallbackFlag(parsed);
  const commandConfig = await readCommandConfig(parsed.flags.config, { cwd: context.cwd, discover: !parsed.flags.config });
  const config = readConfigForCommand(parsed, { ...context, commandConfig }, { allowHiddenEnvironmentSources: true });
  if (parsed.positional.length > 2) throw usageError('USAGE_INVALID', 'deploy 参数过多。', '请使用 xd-cell deploy <目录> <站点名>。');
  const deployConfig = await resolveDeployConfig(parsed, commandConfig, context, { requireSite: true });
  const { siteSlug } = deployConfig;
  const teamOption = Object.hasOwn(parsed.flags, 'team') ? parsed.flags.team : commandConfig?.team;
  const teamId = normalizeTeamId(teamOption);
  const requestedVisibility = parsed.flags.visibility || commandConfig?.visibility;
  if (requestedVisibility && !VALID_VISIBILITIES.has(requestedVisibility)) {
    throw usageError('SITE_VISIBILITY_INVALID', '站点可见性无效。', '请使用 internal、org、acl、owner 或 disabled。');
  }
  if (teamId && requestedVisibility === 'owner') {
    throw usageError(
      'SITE_VISIBILITY_INVALID',
      '团队站点不支持 owner 访问范围。',
      '请使用 internal、org、acl 或 disabled。'
    );
  }
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
      ...(teamId ? { teamId } : {}),
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

  let siteCreated = false;
  const actorInfo = await readCredentialActor(client, credential);
  if (actorInfo?.type !== 'access_key') {
    outputProgress(parsed, context, '准备站点...');
    const visibility = requestedVisibility || 'org';
    try {
      await client.requestApi('POST', '/.xd-pages/api/sites', siteCreateRequest({ slug: siteSlug, visibility, teamId }));
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
      teamId,
      uploadPlan,
      visibility: requestedVisibility,
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
      ...(teamId ? { teamId } : {}),
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
      ...(deployed.deploymentTraceId ? { deploymentTraceId: deployed.deploymentTraceId } : {}),
      deployment: deployed.deployment || null,
      version: deployed.version || null,
      route: deployed.route || null,
      ...(deployed.ownerTransfer ? { ownerTransfer: deployed.ownerTransfer } : {}),
      url,
    })
  ) {
    return 0;
  }
  context.output(`站点名：${siteSlug}`);
  context.output(`识别结果：${humanDeploymentLabel(decision)}`);
  context.output(`找不到文件时：${humanFallbackLabel(decision.resolvedFallback)}`);
  context.output(`部署：${deployed.deployment?.id || 'created'} ${deployed.deployment?.status || ''}`.trim());
  if (deployed.deploymentTraceId) context.output(`追踪：${deployed.deploymentTraceId}`);
  if (url) context.output(`发布完成：${url}`);
  return 0;
}

function buildPublishPlanDeploymentForm({ siteSlug, teamId = '', uploadPlan, visibility = '', vars = {}, varsProvided = false }) {
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
  if (teamId) metadata.teamId = teamId;
  if (visibility) metadata.visibility = visibility;
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

function siteCreateRequest({ slug, visibility, teamId }) {
  const body = { slug, visibility };
  if (teamId) {
    body.ownerType = 'team';
    body.teamId = teamId;
  }
  return body;
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

function normalizeTeamId(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw usageError('TEAM_INVALID', '团队参数无效。', '请传入团队 ID，例如 --team team_xxx。');
  }
  const teamId = value.trim();
  if (!teamId) {
    throw usageError('TEAM_INVALID', '团队参数无效。', '请传入团队 ID，例如 --team team_xxx。');
  }
  if (/[\s/\\]|:\/\//.test(teamId)) {
    throw usageError('TEAM_INVALID', '团队参数无效。', '请传入团队 ID，例如 --team team_xxx。');
  }
  return teamId;
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

function preflightEnvelope({ mode, site, teamId, configPath, target, decision, uploadPlan, checks, sideEffects, runtime = null }) {
  const payload = {
    ok: true,
    schemaVersion: 1,
    type: 'preflight',
    mode,
    ...(site ? { site } : {}),
    ...(teamId ? { teamId } : {}),
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

function nextIdempotencyKey(context) {
  if (typeof context.idempotencyKey === 'function') return context.idempotencyKey();
  return `cli_${randomUUID()}`;
}
