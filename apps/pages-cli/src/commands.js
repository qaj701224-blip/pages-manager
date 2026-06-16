import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseArgs } from './args.js';
import { createApiClient } from './api-client.js';
import { buildArtifactBundle, hashArtifact, inferArtifactKind } from './artifact.js';
import { FIXED_ENVIRONMENTS, readCliConfig, resolveEnvironment } from './config.js';
import { loginWithAccessKey, loginWithBrowser } from './login.js';
import { loadProfile, resolveProfileDir, saveProfile as saveProfileFile } from './profile.js';
import { readProjectConfig, writeProjectConfig } from './project-config.js';
import { createSecretStore } from './secret-store.js';

const VALID_VISIBILITIES = new Set(['public', 'org', 'acl', 'owner', 'disabled']);
const VALID_ARTIFACT_KINDS = new Set(['static', 'spa', 'worker']);

export async function executeCommand(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  const output = options.output || createOutput(options.stdout);
  if (parsed.command === 'help' || parsed.flags.help) {
    outputHelp(parsed, output);
    return 0;
  }
  if (parsed.command === 'version') {
    output(await readCliVersion());
    return 0;
  }

  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const profileDir = options.profileDir || resolveProfileDir({ env, platform: options.platform, homedir: options.homedir });
  const profile = options.profile || (await loadProfile(profileDir));
  const project = await readProjectConfig(cwd);

  switch (parsed.command) {
    case 'login':
      return runLogin(parsed, { ...options, env, profileDir, profile, output });
    case 'deploy':
      return runDeploy(parsed, { ...options, cwd, env, profileDir, profile, project, output });
    case 'status':
      return runStatus(parsed, { ...options, cwd, env, profile, project, output });
    case 'rollback':
      return runRollback(parsed, { ...options, cwd, env, profile, project, output });
    case 'open':
      return runOpen(parsed, { ...options, cwd, env, profile, project, output });
    case 'env':
      return runEnv(parsed, { ...options, env, profileDir, profile, output });
    default:
      throw new Error(`UNKNOWN_COMMAND:${parsed.command}`);
  }
}

async function runLogin(parsed, context) {
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
    noOpen: Boolean(parsed.flags.noOpen),
    pollIntervalMs: context.pollIntervalMs,
  });
  outputJsonResult(parsed, context, { environment: config.environment, credentialType: 'cli_token' });
  return 0;
}

async function runDeploy(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context);
  const client = createClient(config, credential, context);
  const targetPath = path.resolve(context.cwd, parsed.positional[0] || '.');
  const artifactKind = parsed.flags.artifactKind || context.project?.defaultArtifactKind || (await inferArtifactKind(targetPath));
  if (!VALID_ARTIFACT_KINDS.has(artifactKind)) {
    throw usageError('ARTIFACT_KIND_INVALID', 'artifact 类型无效。', '请使用 static、spa 或 worker。');
  }

  const projectForEnvironment = getProjectForEnvironment(context.project, config.environment);
  const saveConfig = Boolean(parsed.flags.saveConfig);
  const explicitSiteSlug = normalizeSiteSlug(parsed.flags.slug);
  let siteId = parsed.flags.site || (explicitSiteSlug ? null : projectForEnvironment?.siteId) || null;
  let project = projectForEnvironment || null;
  let siteSlug = explicitSiteSlug || normalizeSiteSlug(project?.slug) || null;
  let createdAt = project?.createdAt;
  if (!siteId) {
    const slug = siteSlug || normalizeSiteSlug(context.project?.slug);
    if (!slug) {
      throw usageError(
        'SITE_SLUG_REQUIRED',
        '缺少站点名。',
        '请传 --slug <站点名>；如果要保存项目绑定，可以在首次发布时加 --save-config。'
      );
    }
    siteSlug = slug;
    if (credential.type !== 'access_key') {
      const visibility = parsed.flags.visibility || 'org';
      if (!VALID_VISIBILITIES.has(visibility)) {
        throw usageError(
          'SITE_VISIBILITY_INVALID',
          '站点可见性无效。',
          '请使用 public、org、acl、owner 或 disabled。'
        );
      }
      try {
        const created = await client.requestApi('POST', '/.xd-pages/api/sites', { slug, visibility });
        siteId = created.site.id;
        siteSlug = normalizeSiteSlug(created.site.slug) || slug;
        createdAt = nowIso(context);
        project = {
          version: 1,
          environment: config.environment,
          siteId,
          slug: siteSlug,
          defaultArtifactKind: artifactKind,
          createdAt,
        };
      } catch (error) {
        if (error?.code !== 'SITE_SLUG_CONFLICT') throw error;
      }
    }
  }

  const artifact = await hashArtifact(targetPath);
  const artifactBundle = await buildArtifactBundle(targetPath, artifactKind);
  const deployed = await client.requestApi(
    'POST',
    '/.xd-pages/api/deployments',
    {
      ...(siteId ? { siteId } : { siteSlug }),
      artifactKind,
      contentHash: artifact.contentHash,
      artifactBundle,
      source: 'cli',
    },
    { idempotencyKey: nextIdempotencyKey(context) }
  );

  const deployedSiteId = siteId || deployed.deployment?.siteId || deployed.route?.siteId || null;
  const deployedSiteSlug = siteSlug || slugFromHostname(deployed.route?.hostname, config);
  if (saveConfig) {
    if (!deployedSiteId) {
      throw usageError(
        'SITE_ID_MISSING',
        '部署已完成，但服务端没有返回内部站点 ID。',
        '请先不带 --save-config 重试；如果仍然出现，请联系 Pages 平台维护者。'
      );
    }
    await writeProjectConfig(context.cwd, {
      version: 1,
      environment: config.environment,
      siteId: deployedSiteId,
      slug: deployedSiteSlug || project?.slug,
      defaultArtifactKind: artifactKind,
      lastDeploymentId: deployed.deployment?.id,
      lastVersionId: deployed.version?.id,
      createdAt,
      updatedAt: nowIso(context),
    });
  }
  const url = deployed.route?.hostname ? `https://${deployed.route.hostname}` : null;
  if (
    outputJsonResult(parsed, context, {
      environment: config.environment,
      siteId: deployedSiteId,
      slug: deployedSiteSlug || null,
      artifactKind,
      savedProjectConfig: saveConfig,
      deployment: deployed.deployment || null,
      version: deployed.version || null,
      route: deployed.route || null,
      url,
    })
  ) {
    return 0;
  }
  if (deployedSiteSlug) context.output(`站点名：${deployedSiteSlug}`);
  if (deployedSiteId) context.output(`内部站点 ID：${deployedSiteId}`);
  context.output(`部署：${deployed.deployment?.id || 'created'} ${deployed.deployment?.status || ''}`.trim());
  if (url) context.output(`URL ${url}`);
  if (!saveConfig) {
    context.output(
      '未写入 .pages.json。后续可继续用 --slug 指定站点名，或加 --save-config 保存项目绑定。'
    );
  }
  return 0;
}

async function runStatus(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context);
  const client = createClient(config, credential, context);

  if (parsed.flags.deployment) {
    const result = await client.requestApi('GET', `/.xd-pages/api/deployments/${encodeURIComponent(parsed.flags.deployment)}`);
    if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
    context.output(JSON.stringify(result));
    return 0;
  }

  const projectForEnvironment = getProjectForEnvironment(context.project, config.environment);
  const explicitSiteSlug = normalizeSiteSlug(parsed.flags.slug);
  const siteId = parsed.flags.site || (explicitSiteSlug ? null : projectForEnvironment?.siteId);
  const siteSlug = explicitSiteSlug || normalizeSiteSlug(projectForEnvironment?.slug);
  let result;
  if (siteId) {
    result = await client.requestApi('GET', `/.xd-pages/api/sites/${encodeURIComponent(siteId)}`);
  } else if (siteSlug) {
    result = await readSiteBySlug(client, siteSlug);
  } else {
    throw usageError(
      'SITE_REQUIRED',
      '缺少站点名。',
      '请传 --slug <站点名>，或在当前项目里先用 pages deploy --save-config 保存绑定。'
    );
  }
  if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
  context.output(JSON.stringify(result));
  return 0;
}

async function runRollback(parsed, context) {
  const versionId = parsed.positional[0];
  if (!versionId) throw usageError('VERSION_REQUIRED', '缺少版本 ID。', '请传入要回滚到的 versionId。');
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context);
  const client = createClient(config, credential, context);
  const result = await client.requestApi(
    'POST',
    `/.xd-pages/api/versions/${encodeURIComponent(versionId)}/rollback`,
    {},
    {
      idempotencyKey: nextIdempotencyKey(context),
    }
  );
  if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
  context.output(`回滚：${result.deployment?.id || 'created'} ${result.deployment?.status || ''}`.trim());
  return 0;
}

async function runOpen(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const url = siteUrlForSlug(
    normalizeSiteSlug(parsed.flags.slug) || getProjectForEnvironment(context.project, config.environment)?.slug,
    config
  );
  if (outputJsonResult(parsed, context, { environment: config.environment, url })) return 0;
  if (parsed.flags.print) {
    context.output(url);
    return 0;
  }
  await (context.openUrl || defaultOpenUrl)(url);
  context.output(url);
  return 0;
}

async function runEnv(parsed, context) {
  const subcommand = parsed.positional[0] || 'list';
  if (subcommand === 'list') {
    if (outputJsonResult(parsed, context, { environments: ['production', 'staging', 'local', 'custom'] })) return 0;
    for (const name of ['production', 'staging', 'local', 'custom']) context.output(name);
    return 0;
  }

  if (subcommand === 'use') {
    const environment = resolveEnvironment(parsed.positional[1]);
    await saveProfileFile(context.profileDir, {
      ...context.profile,
      activeEnvironment: environment,
    });
    if (outputJsonResult(parsed, context, { activeEnvironment: environment })) return 0;
    context.output(`当前环境：${environment}`);
    return 0;
  }

  if (subcommand === 'set' && parsed.positional[1] === 'custom') {
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

  throw usageError(
    'ENV_COMMAND_INVALID',
    'env 命令不完整或无效。',
    '请使用 pages env list、pages env use <环境> 或 pages env set custom --api <origin> --auth <origin>。'
  );
}

function getProjectForEnvironment(project, environment) {
  if (!project) return null;
  return project.environment === environment ? project : null;
}

async function readSiteBySlug(client, slug) {
  const result = await client.requestApi('GET', '/.xd-pages/api/sites');
  const site = Array.isArray(result?.sites) ? result.sites.find((candidate) => candidate.slug === slug) : null;
  if (!site) {
    throw usageError(
      'SITE_NOT_FOUND',
      `未找到站点：${slug}`,
      '请确认站点名和当前环境；如果还没创建，先执行 pages deploy --slug <站点名>。'
    );
  }
  return { site };
}

function readConfigForCommand(parsed, context) {
  const requestedEnvironment =
    parsed.flags.env ||
    context.env.PAGES_CLI_ENV ||
    context.project?.environment ||
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

async function resolveCredential(environment, context) {
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
  if (!normalized) {
    throw usageError('SITE_BINDING_REQUIRED', '当前项目没有站点绑定。', '请传 --slug <站点名>，或先用 --save-config 保存绑定。');
  }
  if (config.environment === 'staging') return `https://${normalized}-staging.${config.siteDomainSuffix}`;
  return `https://${normalized}.${config.siteDomainSuffix}`;
}

function slugFromHostname(hostname, config) {
  if (typeof hostname !== 'string' || !hostname) return null;
  const suffix = `.${config.siteDomainSuffix}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  if (config.environment === 'staging' && label.endsWith('-staging')) {
    return normalizeSiteSlug(label.slice(0, -'-staging'.length));
  }
  return normalizeSiteSlug(label);
}

function normalizeSiteSlug(value) {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return slug || null;
}

function nextIdempotencyKey(context) {
  if (typeof context.idempotencyKey === 'function') return context.idempotencyKey();
  return `cli_${randomUUID()}`;
}

function outputJsonResult(parsed, context, payload) {
  if (!parsed.flags.json) return false;
  context.output(JSON.stringify({ ok: true, ...payload }));
  return true;
}

function outputHelp(parsed, output) {
  const topic = parsed.command === 'help' ? parsed.positional[0] : parsed.command;
  const body = helpText(topic || 'overview');
  if (parsed.flags.json) {
    output(JSON.stringify({ ok: true, help: helpJson(topic || 'overview') }));
    return;
  }
  output(body);
}

function helpText(topic) {
  if (topic === 'deploy') {
    return `用法：pages deploy [目录] [选项]

发布 static 站点、SPA 或自定义 Worker 到 XD Pages v2。

选项：
  --env <production|staging|local|custom>   目标环境；默认使用当前 profile，未设置时为 production。
  --slug <站点名>                            用户可见站点名，例如 docs；每个环境内唯一，推荐日常使用。
  --site <site_id>                          高级参数：内部站点 ID；通常不需要手写。
  --visibility <public|org|acl|owner|disabled>
                                            创建站点时的初始可见性；默认 org。
  --artifact-kind <static|spa|worker>       覆盖 artifact 类型自动识别。
  --save-config                             写入或更新 .pages.json，只保存非敏感项目绑定。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

示例：
  pages deploy ./dist --slug demo --visibility org
  pages deploy ./dist --slug demo --visibility org --save-config
  PAGES_ACCESS_KEY=<access-key> pages deploy ./dist --slug demo --json

说明：
  pages deploy 默认不写 .pages.json；需要保存项目绑定时显式加 --save-config。
  access key 不能创建站点；请先用用户登录创建站点，CI/agent 后续用 --slug 发布已有站点。
  --site 是内部 ID 逃生口；优先使用 --slug。
  CLI 不暴露底层执行平台细节。`;
  }
  if (topic === 'login') {
    return `用法：pages login [选项]

登录 XD Pages v2 CLI。

选项：
  --env <production|staging|local|custom>   目标环境；默认 production。
  --access-key <key>                        显式保存已有 access key。
  --no-open                                 只打印浏览器地址，不自动打开。
  --json                                    输出稳定 JSON，不输出 secret。
  --help                                    显示帮助。`;
  }
  if (topic === 'status') {
    return `用法：pages status [选项]

查看站点或部署状态。

选项：
  --env <production|staging|local|custom>   目标环境。
  --slug <站点名>                            用户可见站点名；推荐日常使用。
  --site <site_id>                          高级参数：内部站点 ID；默认读取当前环境的 .pages.json。
  --deployment <deployment_id>              按部署 ID 查看部署状态。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'rollback') {
    return `用法：pages rollback <version_id> [选项]

回滚站点到一个已存在的不可变版本。

选项：
  --env <production|staging|local|custom>   目标环境。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'open') {
    return `用法：pages open [选项]

打开或打印当前 .pages.json 绑定的站点地址。

选项：
  --env <production|staging|local|custom>   目标环境。
  --slug <站点名>                            不依赖 .pages.json，直接打开指定站点名。
  --print                                   只打印 URL，不打开浏览器。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  if (topic === 'env') {
    return `用法：pages env <list|use|set> [选项]

管理本地 CLI 环境选择。

命令：
  pages env list
  pages env use <production|staging|local|custom>
  pages env set custom --api <origin> --auth <origin> [--site-domain-suffix <suffix>]

选项：
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。`;
  }
  return `用法：pages <命令> [选项]

命令：
  login       通过浏览器 SSO 登录，或显式保存 access key。
  deploy      发布 static 站点、SPA 或自定义 Worker。
  status      查看站点或部署状态。
  rollback    回滚到不可变版本 ID。
  open        打开或打印当前站点地址。
  env         查看、切换或配置环境。

全局选项：
  --env <production|staging|local|custom>   目标环境。
  --json                                    在支持的命令中输出稳定 JSON，适合 AI agent 和 CI。
  --help, -h                                显示帮助。
  --version, -v                             显示 CLI 版本。

查看某个命令的参数：
  pages help deploy`;
}

function helpJson(topic) {
  return {
    topic,
    commands: ['login', 'deploy', 'status', 'rollback', 'open', 'env'],
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

function nowIso(context) {
  if (typeof context.nowIso === 'function') return context.nowIso();
  return new Date().toISOString();
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
