const DEFAULT_API_BASE = 'https://api.workers.xd.team';
const DEFAULT_DOMAIN_BASE = 'workers.xd.team';
const DEFAULT_MANAGER_WORKER_NAME = 'pages-manager';
const DEFAULT_WORKER_PREFIX = 'pages-';
const DEFAULT_WORKERS_DEV_SUBDOMAIN = 'xd-cf-2022';

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function requestOrigin(request) {
  if (!request?.url) return null;
  return new URL(request.url).origin;
}

function urlHost(value) {
  if (!value) return '';
  return new URL(value).host;
}

export function getPublicConfig(request, env = {}) {
  const domainBase = env.DOMAIN_BASE || DEFAULT_DOMAIN_BASE;
  const domainLabel = env.DOMAIN_LABEL || '';
  const workerPrefix = env.WORKER_PREFIX || DEFAULT_WORKER_PREFIX;
  const workersDevSubdomain = env.WORKERS_DEV_SUBDOMAIN || DEFAULT_WORKERS_DEV_SUBDOMAIN;
  const managerWorkerName = env.PAGES_MANAGER_WORKER_NAME || DEFAULT_MANAGER_WORKER_NAME;
  const apiBase = trimTrailingSlash(env.PUBLIC_API_BASE || requestOrigin(request) || DEFAULT_API_BASE);
  const managerDevBase = trimTrailingSlash(
    env.PUBLIC_MANAGER_DEV_BASE || (workersDevSubdomain ? `https://${managerWorkerName}.${workersDevSubdomain}.workers.dev` : '')
  );

  return {
    apiBase,
    domainBase,
    domainLabel,
    workerPrefix,
    workersDevSubdomain,
    managerWorkerName,
    managerDevBase,
    environment: env.PUBLIC_ENVIRONMENT || 'production',
    siteHost(name = '{name}') {
      return `${name}${domainLabel}.${domainBase}`;
    },
    siteUrl(name = '{name}') {
      return `https://${this.siteHost(name)}`;
    },
    scriptName(name = '{name}') {
      return `${workerPrefix}${name}`;
    },
    devUrl(name = '{name}') {
      if (!workersDevSubdomain) return null;
      return `https://${this.scriptName(name)}.${workersDevSubdomain}.workers.dev`;
    },
  };
}

export function replacePublicText(value, config) {
  const replacements = [
    ['https://pages-manager.xd-cf-2022.workers.dev', config.managerDevBase || config.apiBase],
    ['https://api.workers.xd.team', config.apiBase],
    ['`pages-manager`，绑定', `\`${config.managerWorkerName}\`，绑定`],
    ['api.workers.xd.team', urlHost(config.apiBase)],
    ['https://pages-q2-report.xd-cf-2022.workers.dev', config.devUrl('q2-report') || ''],
    ['https://q2-report.workers.xd.team', config.siteUrl('q2-report')],
    ['https://my-app.workers.xd.team', config.siteUrl('my-app')],
    ['https://demo-api.workers.xd.team', config.siteUrl('demo-api')],
    ['https://{name}.workers.xd.team', config.siteUrl('{name}')],
    ['{name}.workers.xd.team', config.siteHost('{name}')],
  ];

  return replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
}

export function applyPublicConfig(value, config) {
  if (typeof value === 'string') return replacePublicText(value, config);
  if (Array.isArray(value)) return value.map((item) => applyPublicConfig(item, config));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyPublicConfig(item, config)]));
}
