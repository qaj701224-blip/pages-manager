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
  if (!VALID_ARTIFACT_KINDS.has(artifactKind)) throw new Error('ARTIFACT_KIND_INVALID');

  const projectForEnvironment = getProjectForEnvironment(context.project, config.environment);
  const saveConfig = Boolean(parsed.flags.saveConfig);
  let siteId = parsed.flags.site || projectForEnvironment?.siteId || null;
  let project = projectForEnvironment || null;
  let siteSlug = parsed.flags.slug || project?.slug || null;
  let createdAt = project?.createdAt;
  if (!siteId) {
    if (credential.type === 'access_key') {
      throw usageError(
        'SITE_ID_REQUIRED_FOR_ACCESS_KEY',
        'Site id is required when deploying with a Pages access key.',
        'Pass --site <site_id>, or create the site with `pages deploy --slug <slug> --save-config` after `pages login`.'
      );
    }
    const slug = siteSlug || context.project?.slug;
    if (!slug) throw new Error('SITE_SLUG_REQUIRED');
    const visibility = parsed.flags.visibility || 'org';
    if (!VALID_VISIBILITIES.has(visibility)) throw new Error('SITE_VISIBILITY_INVALID');
    const created = await client.requestApi('POST', '/.xd-pages/api/sites', { slug, visibility });
    siteId = created.site.id;
    siteSlug = created.site.slug || slug;
    createdAt = nowIso(context);
    project = {
      version: 1,
      environment: config.environment,
      siteId,
      slug: siteSlug,
      defaultArtifactKind: artifactKind,
      createdAt,
    };
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

  if (saveConfig) {
    await writeProjectConfig(context.cwd, {
      version: 1,
      environment: config.environment,
      siteId,
      slug: siteSlug || project?.slug,
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
      siteId,
      slug: siteSlug || null,
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
  context.output(`Site ${siteId}`);
  context.output(`Deployment ${deployed.deployment?.id || 'created'} ${deployed.deployment?.status || ''}`.trim());
  if (url) context.output(`URL ${url}`);
  if (!saveConfig) {
    context.output(
      'Project config not saved. Reuse this site with --site, or add --save-config to write .pages.json.'
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
  const siteId = parsed.flags.site || projectForEnvironment?.siteId;
  if (!siteId) throw new Error('SITE_REQUIRED');
  const result = await client.requestApi('GET', `/.xd-pages/api/sites/${encodeURIComponent(siteId)}`);
  if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
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
  if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
  context.output(`Rollback ${result.deployment?.id || 'created'} ${result.deployment?.status || ''}`.trim());
  return 0;
}

async function runOpen(parsed, context) {
  const config = readConfigForCommand(parsed, context);
  const url = siteUrlForProject(getProjectForEnvironment(context.project, config.environment), config);
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
    if (outputJsonResult(parsed, context, { activeEnvironment: 'custom', custom })) return 0;
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
    return `Usage: pages deploy [dir] [options]

Deploy a static site, SPA, or custom Worker to XD Pages v2.

Options:
  --env <production|staging|local|custom>   Target environment. Defaults to active profile or production.
  --site <site_id>                          Existing site id. Required when using PAGES_ACCESS_KEY without .pages.json.
  --slug <site-slug>                        Site slug for first deploy or local project binding.
  --visibility <public|org|acl|owner|disabled>
                                            Initial visibility when CLI creates a site. Default: org.
  --artifact-kind <static|spa|worker>       Override artifact type inference.
  --save-config                             Write or update .pages.json with non-secret project binding data.
  --json                                    Print stable JSON for agents and CI.
  --help                                    Show this help.

Examples:
  pages deploy ./dist --slug demo --visibility org
  pages deploy ./dist --slug demo --visibility org --save-config
  PAGES_ACCESS_KEY=<access-key> pages deploy ./dist --site site_xxx --json

Notes:
  pages deploy does not write .pages.json unless --save-config is set.
  Access keys cannot create sites. Create the site once with pages login, or pass --site for CI/agent deploys.
  The CLI does not expose underlying platform execution details.`;
  }
  if (topic === 'login') {
    return `Usage: pages login [options]

Authenticate the local CLI with XD Pages v2.

Options:
  --env <production|staging|local|custom>   Target environment. Defaults to production.
  --access-key <key>                        Save an existing access key explicitly.
  --no-open                                 Print browser URL without opening it.
  --json                                    Print stable JSON without secrets.
  --help                                    Show this help.`;
  }
  if (topic === 'status') {
    return `Usage: pages status [options]

Read site or deployment status.

Options:
  --env <production|staging|local|custom>   Target environment.
  --site <site_id>                          Site id. Defaults to .pages.json for the active environment.
  --deployment <deployment_id>              Read a deployment by id.
  --json                                    Print stable JSON for agents and CI.
  --help                                    Show this help.`;
  }
  if (topic === 'rollback') {
    return `Usage: pages rollback <version_id> [options]

Rollback a site route to an existing immutable version.

Options:
  --env <production|staging|local|custom>   Target environment.
  --json                                    Print stable JSON for agents and CI.
  --help                                    Show this help.`;
  }
  if (topic === 'open') {
    return `Usage: pages open [options]

Open or print the current site URL from .pages.json.

Options:
  --env <production|staging|local|custom>   Target environment.
  --print                                   Print URL without opening a browser.
  --json                                    Print stable JSON for agents and CI.
  --help                                    Show this help.`;
  }
  if (topic === 'env') {
    return `Usage: pages env <list|use|set> [options]

Manage local CLI environment selection.

Commands:
  pages env list
  pages env use <production|staging|local|custom>
  pages env set custom --api <origin> --auth <origin> [--site-domain-suffix <suffix>]

Options:
  --json                                    Print stable JSON for agents and CI.
  --help                                    Show this help.`;
  }
  return `Usage: pages <command> [options]

Commands:
  login       Authenticate with browser SSO or save an explicit access key.
  deploy      Deploy a static site, SPA, or custom Worker.
  status      Read site or deployment status.
  rollback    Roll back to an immutable version id.
  open        Open or print the current site URL.
  env         List, switch, or configure environments.

Global options:
  --env <production|staging|local|custom>   Target environment.
  --json                                    Print stable JSON for agents and CI where supported.
  --help, -h                                Show help.
  --version, -v                             Show CLI version.

Run pages help <command> for command parameters, for example:
  pages help deploy`;
}

function helpJson(topic) {
  return {
    topic,
    commands: ['login', 'deploy', 'status', 'rollback', 'open', 'env'],
    commandHelp: 'pages help <command>',
    jsonOutput: 'Use --json for stable machine-readable output. Secrets are never printed.',
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
