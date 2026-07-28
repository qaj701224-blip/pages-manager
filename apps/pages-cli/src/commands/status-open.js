import { runAuthStatus } from './auth.js';
import {
  assertNoPositionals,
  createClient,
  outputJsonResult,
  readConfigForCommand,
  readSingleSiteArg,
  readSiteBySlug,
  readSiteVisibility,
  resolveCredential,
  siteUrlForSlug,
} from './shared.js';

export async function runStatus(parsed, context) {
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

export async function runOpen(parsed, context) {
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

function siteUrlForOpen(site, config) {
  if (site?.url) return site.url;
  if (site?.route?.hostname) return `https://${site.route.hostname}`;
  return siteUrlForSlug(site?.slug, config);
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

async function defaultOpenUrl(url) {
  const { execFile } = await import('node:child_process');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}
