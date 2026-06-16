#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { executeCommand } from './commands.js';

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const commandRunner = io.commandRunner || executeCommand;
  try {
    await commandRunner(argv, {
      ...io,
      env: io.env || process.env,
      stdout,
    });
    return 0;
  } catch (error) {
    write(stderr, wantsJson(argv) ? `${formatErrorJson(error)}\n` : `${formatError(error)}\n`);
    return 1;
  }
}

function write(stream, text) {
  if (typeof stream?.write === 'function') stream.write(text);
}

function formatError(error) {
  if (!error || typeof error !== 'object') return String(error);
  const localized = localizeError(error);
  const code = localized.code;
  const message = localized.message && localized.message !== code ? ` ${localized.message}` : '';
  const action = localized.action ? ` ${localized.action}` : '';
  return `${code}${message}${action}`;
}

function formatErrorJson(error) {
  if (!error || typeof error !== 'object') {
    return JSON.stringify({ ok: false, error: { code: 'CLI_ERROR', message: String(error) } });
  }
  const localized = localizeError(error);
  const payload = {
    ok: false,
    error: {
      code: localized.code,
      message: localized.message || localized.code,
    },
  };
  if (localized.action) payload.error.action = localized.action;
  return JSON.stringify(payload);
}

function localizeError(error) {
  const rawCode = error.code || error.message || 'CLI_ERROR';
  const code = rawCode.startsWith('UNKNOWN_COMMAND:') ? 'UNKNOWN_COMMAND' : rawCode;
  const command = rawCode.startsWith('UNKNOWN_COMMAND:') ? rawCode.slice('UNKNOWN_COMMAND:'.length) : '';
  const known = {
    PAGES_CREDENTIAL_REQUIRED: {
      message: '缺少 Pages 登录凭证。',
      action: '请先运行 pages login；CI/agent 可以设置 PAGES_ACCESS_KEY。',
    },
    SITE_REQUIRED: {
      message: '缺少站点名。',
      action: '请传 --slug <站点名>，或在当前项目里先用 --save-config 保存绑定。',
    },
    SITE_SLUG_REQUIRED: {
      message: '缺少站点名。',
      action: '请传 --slug <站点名>。',
    },
    SITE_NOT_FOUND: {
      message: error.message && /^未找到/.test(error.message) ? error.message : '未找到站点。',
      action: '请确认站点名和当前环境；如果使用 access key，请确认它绑定的是这个站点。',
    },
    SITE_VISIBILITY_INVALID: {
      message: '站点可见性无效。',
      action: '请使用 public、org、acl、owner 或 disabled。',
    },
    ARTIFACT_KIND_INVALID: {
      message: 'artifact 类型无效。',
      action: '请使用 static、spa 或 worker。',
    },
    VERSION_REQUIRED: {
      message: '缺少版本 ID。',
      action: '请传入要回滚到的 versionId。',
    },
    SITE_BINDING_REQUIRED: {
      message: '当前项目没有站点绑定。',
      action: '请传 --slug <站点名>，或先用 --save-config 保存绑定。',
    },
    ENV_COMMAND_INVALID: {
      message: 'env 命令不完整或无效。',
      action: '请使用 pages env list、pages env use <环境> 或 pages env set custom。',
    },
    UNKNOWN_COMMAND: {
      message: command ? `未知命令：${command}` : '未知命令。',
      action: '运行 pages help 查看可用命令。',
    },
  };
  const translated = known[code];
  if (translated) return { code, ...translated };
  return {
    code,
    message: error.message || code,
    action: error.action,
  };
}

function wantsJson(argv) {
  return Array.isArray(argv) && argv.some((token) => token === '--json' || token.startsWith('--json='));
}

export function isCliEntrypoint(moduleUrl = import.meta.url, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntrypoint()) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
