import {
  assertNoPositionals,
  createClient,
  formatJson,
  outputJsonResult,
  readConfigForCommand,
  readSingleSiteArg,
  readSiteBySlug,
  readSiteVisibility,
  resolveCredential,
  usageError,
} from './shared.js';

export async function runSites(parsed, context) {
  const subcommand = parsed.positional[0] || 'list';
  const child = { ...parsed, positional: parsed.positional.slice(1) };
  let siteSlug;

  if (subcommand === 'list') {
    if (parsed.flags.yes !== undefined) {
      throw usageError('SITES_LIST_USAGE_INVALID', 'sites list 不接受 --yes。', '请使用 xd-cell sites list [--details]。');
    }
    assertNoPositionals(child, 'SITES_LIST_USAGE_INVALID', 'xd-cell sites list 不接受位置参数。');
  } else if (subcommand === 'info') {
    if (parsed.flags.yes !== undefined) {
      throw usageError('SITES_INFO_USAGE_INVALID', 'sites info 不接受 --yes。', '请使用 xd-cell sites info <站点名>。');
    }
    siteSlug = readSingleSiteArg(child, 'SITES_INFO_USAGE_INVALID', '请使用 xd-cell sites info <站点名>。');
  } else if (subcommand === 'delete') {
    if (parsed.flags.details !== undefined) {
      throw usageError('SITES_DELETE_USAGE_INVALID', 'sites delete 不接受 --details。', '请使用 xd-cell sites delete <站点名>。');
    }
    siteSlug = readSingleSiteArg(child, 'SITES_DELETE_USAGE_INVALID', '请使用 xd-cell sites delete <站点名>。');
  } else {
    throw usageError(
      'SITES_COMMAND_INVALID',
      'sites 命令无效。',
      '请使用 xd-cell sites list、xd-cell sites info <站点名> 或 xd-cell sites delete <站点名>。'
    );
  }

  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  if (subcommand === 'list') {
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
    const result = await readSiteBySlug(client, siteSlug);
    if (outputJsonResult(parsed, context, { environment: config.environment, ...result })) return 0;
    outputSiteInfo(context.output, config.environment, result.site);
    return 0;
  }

  const { site } = await readSiteBySlug(client, siteSlug);
  if (!parsed.flags.yes) {
    if (parsed.flags.json || !context.stdin?.isTTY || typeof context.readConfirmation !== 'function') {
      throw usageError(
        'SITE_DELETE_CONFIRMATION_REQUIRED',
        '删除站点需要显式确认。',
        '确认目标后添加 --yes；JSON 和非交互环境必须使用 --yes。'
      );
    }
    const answer = await context.readConfirmation(`确认删除站点 "${site.slug}"? (y/N) `);
    if (!['y', 'yes'].includes(String(answer ?? '').trim().toLowerCase())) {
      context.output(`已取消删除站点：${site.slug}`);
      return 0;
    }
  }

  await client.requestApi('DELETE', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}`);
  if (
    outputJsonResult(parsed, context, {
      type: 'site',
      environment: config.environment,
      site: site.slug,
      operation: 'delete',
      deleted: true,
    })
  ) {
    return 0;
  }
  context.output(`已删除站点：${site.slug}`);
  return 0;
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
