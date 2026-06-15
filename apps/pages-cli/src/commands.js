import { randomUUID } from 'node:crypto';
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
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const output = options.output || createOutput(options.stdout);
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
    case 'help':
      output('Usage: pages <login|deploy|status|rollback|open|env> [options]');
      return 0;
    default:
      throw new Error(`UNKNOWN_COMMAND:${parsed.command}`);
  }
}

async function runLogin(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const secretStore = context.secretStore || createSecretStore({ profileDir: context.profileDir, platform: context.platform });
  const saveProfile = (profile) => saveProfileFile(context.profileDir, profile);

  if (parsed.flags.accessKey) {
    await loginWithAccessKey({
      config,
      accessKey: parsed.flags.accessKey,
      secretStore,
      profile: context.profile,
      saveProfile,
      now: context.nowIso,
      output: context.output,
    });
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
    output: context.output,
    noOpen: Boolean(parsed.flags.noOpen),
    pollIntervalMs: context.pollIntervalMs,
  });
  return 0;
}

async function runDeploy(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context);
  const client = createClient(config, credential, context);
  const targetPath = path.resolve(context.cwd, parsed.positional[0] || '.');
  const artifactKind = parsed.flags.artifactKind || context.project?.defaultArtifactKind || (await inferArtifactKind(targetPath));
  if (!VALID_ARTIFACT_KINDS.has(artifactKind)) throw new Error('ARTIFACT_KIND_INVALID');

  const projectForEnvironment = getProjectForEnvironment(context.project, config.environment);
  let siteId = parsed.flags.site || projectForEnvironment?.siteId || null;
  let project = projectForEnvironment || null;
  if (!siteId) {
    const slug = parsed.flags.slug || project?.slug || context.project?.slug;
    if (!slug) throw new Error('SITE_SLUG_REQUIRED');
    const visibility = parsed.flags.visibility || 'org';
    if (!VALID_VISIBILITIES.has(visibility)) throw new Error('SITE_VISIBILITY_INVALID');
    const created = await client.requestApi('POST', '/.xd-pages/api/sites', { slug, visibility });
    siteId = created.site.id;
    project = await writeProjectConfig(context.cwd, {
      version: 1,
      environment: config.environment,
      siteId,
      slug: created.site.slug || slug,
      defaultArtifactKind: artifactKind,
      createdAt: nowIso(context),
      updatedAt: nowIso(context),
    });
  }

  const artifact = await hashArtifact(targetPath);
  const artifactBundle = await buildArtifactBundle(targetPath, artifactKind);
  const deployed = await client.requestApi(
    'POST',
    '/.xd-pages/api/deployments',
    {
      siteId,
      artifactKind,
      contentHash: artifact.contentHash,
      artifactBundle,
      source: 'cli',
    },
    { idempotencyKey: nextIdempotencyKey(context) }
  );

  await writeProjectConfig(context.cwd, {
    version: 1,
    environment: config.environment,
    siteId,
    slug: project?.slug || parsed.flags.slug,
    defaultArtifactKind: artifactKind,
    lastDeploymentId: deployed.deployment?.id,
    lastVersionId: deployed.version?.id,
    updatedAt: nowIso(context),
  });
  context.output(`Deployment ${deployed.deployment?.id || 'created'} ${deployed.deployment?.status || ''}`.trim());
  if (deployed.route?.hostname) context.output(`URL https://${deployed.route.hostname}`);
  return 0;
}

async function runStatus(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context);
  const client = createClient(config, credential, context);

  if (parsed.flags.deployment) {
    const result = await client.requestApi('GET', `/.xd-pages/api/deployments/${encodeURIComponent(parsed.flags.deployment)}`);
    context.output(JSON.stringify(result));
    return 0;
  }

  const projectForEnvironment = getProjectForEnvironment(context.project, config.environment);
  const siteId = parsed.flags.site || projectForEnvironment?.siteId;
  if (!siteId) throw new Error('SITE_REQUIRED');
  const result = await client.requestApi('GET', `/.xd-pages/api/sites/${encodeURIComponent(siteId)}`);
  context.output(JSON.stringify(result));
  return 0;
}

async function runRollback(parsed, context) {
  const versionId = parsed.positional[0];
  if (!versionId) throw new Error('VERSION_REQUIRED');
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
  context.output(`Rollback ${result.deployment?.id || 'created'} ${result.deployment?.status || ''}`.trim());
  return 0;
}

async function runOpen(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const url = siteUrlForProject(getProjectForEnvironment(context.project, config.environment), config);
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
    for (const name of ['production', 'staging', 'local', 'custom']) context.output(name);
    return 0;
  }

  if (subcommand === 'use') {
    const environment = resolveEnvironment(parsed.positional[1]);
    await saveProfileFile(context.profileDir, {
      ...context.profile,
      activeEnvironment: environment,
    });
    context.output(`Active environment: ${environment}`);
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
    context.output('Custom environment saved.');
    return 0;
  }

  throw new Error('ENV_COMMAND_INVALID');
}

function getProjectForEnvironment(project, environment) {
  if (!project) return null;
  return project.environment === environment ? project : null;
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

function siteUrlForProject(project, config) {
  if (!project?.slug) throw new Error('SITE_BINDING_REQUIRED');
  if (config.environment === 'staging') return `https://${project.slug}-staging.${config.siteDomainSuffix}`;
  return `https://${project.slug}.${config.siteDomainSuffix}`;
}

function nextIdempotencyKey(context) {
  if (typeof context.idempotencyKey === 'function') return context.idempotencyKey();
  return `cli_${randomUUID()}`;
}

function nowIso(context) {
  if (typeof context.nowIso === 'function') return context.nowIso();
  return new Date().toISOString();
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
