import {
  createClient,
  normalizeSiteSlug,
  outputJsonResult,
  readConfigForCommand,
  resolveCredential,
  usageError,
} from './shared.js';

export async function runSecrets(parsed, context) {
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
