import { readFile } from 'node:fs/promises';

import { createApiClient } from '../api-client.js';
import { readCliConfig } from '../config.js';
import { createSecretStore } from '../secret-store.js';

export const VALID_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
export const USER_ENVIRONMENTS = ['production', 'staging'];
const HELP_FLAGS = new Set(['help', 'json', 'token', 'accessKey']);
const VERSION_FLAGS = new Set(['help', 'token', 'accessKey']);
const LOGIN_FLAGS = new Set(['env', 'token', 'accessKey', 'noOpen', 'json', 'help']);
const DEPLOY_FLAGS = new Set([
  'env',
  'team',
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
const SITES_FLAGS = new Set(['env', 'token', 'accessKey', 'json', 'help', 'details', 'yes']);
const TEAMS_FLAGS = new Set(['env', 'token', 'accessKey', 'json', 'help']);
const AUTH_ENV_FLAGS = new Set(['env', 'json', 'help', 'token', 'accessKey']);
const STATUS_FLAGS = new Set(['env', 'deployment', 'token', 'accessKey', 'json', 'help']);
const OPEN_FLAGS = new Set(['env', 'print', 'json', 'help', 'token', 'accessKey']);
const ACCESS_FLAGS = new Set(['env', 'visibility', 'email', 'department', 'token', 'accessKey', 'json', 'help']);
const ENV_FLAGS = new Set(['json', 'help', 'token', 'accessKey']);
const DEPRECATED_HIDDEN_TOKEN_FLAGS = new Set(['accessKey']);

export function validateCommandUsage(parsed) {
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
  if (parsed.command === 'teams') return TEAMS_FLAGS;
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

export async function readSiteBySlug(client, slug) {
  const result = await client.requestApi('GET', '/.xd-pages/api/sites');
  const site = Array.isArray(result?.sites) ? result.sites.find((candidate) => candidate.slug === slug) : null;
  if (!site) {
    const suggestion = suggestClosestSlug(slug, result?.sites || []);
    throw usageError(
      'SITE_NOT_FOUND',
      `未找到站点：${slug}`,
      suggestion
        ? `未找到 ${slug}。你是不是想查看 ${suggestion}？站点也可能已改名，请运行 xd-cell sites list 查看当前站点名。`
        : '站点可能已改名，请运行 xd-cell sites list 查看当前站点名；同时请确认站点名和站点权限，如果使用 API token，请确认它绑定的是这个站点。'
    );
  }
  return { site };
}

export function readConfigForCommand(parsed, context, options = {}) {
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

export function readHiddenEnvironment(value) {
  if (USER_ENVIRONMENTS.includes(value)) return value;
  throw usageError('ENVIRONMENT_INVALID', '环境无效。', '请使用 production 或 staging。');
}

export function readOneShotToken(parsed) {
  if (parsed.flags.token) return parsed.flags.token;
  // Kept only for old scripts. Public help and docs teach --token.
  for (const flag of DEPRECATED_HIDDEN_TOKEN_FLAGS) {
    if (parsed.flags[flag]) return parsed.flags[flag];
  }
  return null;
}

export async function resolveCredential(environment, context, parsed) {
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

export function createClient(config, credential, context) {
  return createApiClient({
    apiBaseUrl: config.apiBaseUrl,
    authBaseUrl: config.authBaseUrl,
    credential,
    fetch: context.fetch,
  });
}

export function siteUrlForSlug(slug, config) {
  const normalized = normalizeSiteSlug(slug);
  if (!normalized) throw usageError('SITE_REQUIRED', '缺少站点名。', '请传入站点名。');
  if (config.environment === 'staging') return `https://${normalized}-staging.${config.siteDomainSuffix}`;
  return `https://${normalized}.${config.siteDomainSuffix}`;
}

export function normalizeSiteSlug(value) {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return slug || null;
}

export function readSingleSiteArg(parsed, code, action) {
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

export function readSiteVisibility(site) {
  return site?.route?.visibility || site?.defaultVisibility || null;
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

export function assertNoPositionals(parsed, code, message) {
  if (parsed.positional.length > 0) throw usageError(code, message, '运行 xd-cell help 查看用法。');
}

export function assertTokenNotUsed(parsed) {
  if (readOneShotToken(parsed)) {
    throw usageError(
      'ACCESS_KEY_NOT_USED',
      '当前命令不会使用 token。',
      '请只在 login、deploy、status、sites、access、secrets 或 whoami 等需要访问 API 的命令中传 --token。'
    );
  }
}

export function outputJsonResult(parsed, context, payload) {
  if (!parsed.flags.json) return false;
  context.output(formatJson({ ok: true, schemaVersion: 1, ...payload }));
  return true;
}

export function outputProgress(parsed, context, line) {
  if (!parsed.flags.json) context.output(line);
}

export function outputHelp(parsed, output) {
  const topic = parsed.command === 'help' ? parsed.positional[0] : parsed.command;
  if (topic === 'rollback') throw unsupportedRollbackError();
  if (topic === 'env') throw unsupportedEnvError();
  if (parsed.flags.json) {
    output(formatJson({ ok: true, schemaVersion: 1, help: helpJson(topic || 'overview') }));
    return;
  }
  output(helpText(topic || 'overview'));
}

export function formatJson(value) {
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
  --team <teamId>                           以有发布权限的团队身份发布；新站点归属该团队。
  --visibility <internal|org|acl|owner|disabled>
                                            创建站点时的初始访问范围；默认 org。
  --dry-run                                 只做本地预演，不创建站点、不上传文件。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --config <file>                           读取发布模板。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

示例：
  xd-cell deploy ./dist demo --visibility org
  xd-cell deploy ./dist demo --team team_xxx
  xd-cell deploy ./src/index.js demo --assets ./dist
  XD_CELL_API_TOKEN=<token> xd-cell deploy ./dist demo --json
  xd-cell deploy --config xd-cell.config.json

说明：
  xd-cell.config.json 只保存非敏感发布模板字段，例如 name、team、main、assets.directory、vars、visibility。
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
      xd-cell sites delete <站点名> [--yes] [选项]

查看站点列表、站点详情或删除站点。

选项：
  --yes                                     确认删除；JSON 和非交互环境必须显式传入。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --details                                 仅 sites list 输出完整站点详情；默认只显示概要。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

说明：
  sites delete 默认要求交互确认；取消不发送删除请求。`;
  }
  if (topic === 'teams') {
    return `用法：xd-cell teams [选项]

查看当前登录用户所在团队，获取可用于 xd-cell deploy --team <teamId> 的团队 ID。

选项：
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
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
  sites       查看站点列表、详情或删除站点。
  teams       查看当前用户所在团队及团队 ID。
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
    commands: ['login', 'logout', 'whoami', 'detect', 'deploy', 'status', 'sites', 'teams', 'secrets', 'access', 'open'],
    commandHelp: 'xd-cell help <命令>',
    jsonOutput: '使用 --json 输出稳定机器可读结果。CLI 不会输出 secret。',
  };
}

export function usageError(code, message, action) {
  const error = new Error(message);
  error.code = code;
  error.action = action;
  return error;
}

export function createOutput(stdout) {
  return (line) => {
    if (typeof stdout?.write === 'function') stdout.write(`${line}\n`);
  };
}

export async function readCliVersion() {
  const packageJson = JSON.parse(await readFirstExistingPackageJson());
  return packageJson.version || 'unknown';
}

async function readFirstExistingPackageJson() {
  const candidates = [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)];
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
