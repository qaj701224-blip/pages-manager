#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readPublicDiagnostics } from './api-client.js';
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
      readSecret: io.readSecret || ((prompt) => readHiddenLine(prompt, {
        stdin: io.stdin || process.stdin,
        stdout,
      })),
    });
    return 0;
  } catch (error) {
    write(stderr, wantsJson(argv) ? `${formatErrorJson(error)}\n` : `${formatError(error)}\n`);
    return 1;
  }
}

export function readHiddenLine(prompt = '', { stdin = process.stdin, stdout = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!stdin?.isTTY || typeof stdin.setRawMode !== 'function' || typeof stdin.resume !== 'function') {
      reject(codedError('SECRET_STDIN_REQUIRED'));
      return;
    }

    let value = '';
    const previousRawMode = Boolean(stdin.isRaw);
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
    };
    const finish = () => {
      cleanup();
      write(stdout, '\n');
      resolve(value);
    };
    const cancel = () => {
      cleanup();
      write(stdout, '\n');
      reject(codedError('SECRET_INPUT_CANCELLED'));
    };
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cancel();
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };

    write(stdout, prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function write(stream, text) {
  if (typeof stream?.write === 'function') stream.write(text);
}

function formatError(error) {
  if (!error || typeof error !== 'object') return String(error);
  const localized = localizeError(error);
  const code = localized.code;
  const message = localized.message && localized.message !== code ? ` ${localized.message}` : '';
  const reason = localized.reason ? ` reason=${localized.reason}` : '';
  const requestId = localized.requestId ? ` requestId=${localized.requestId}` : '';
  const action = localized.action ? ` ${localized.action}` : '';
  return `${code}${message}${reason}${requestId}${action}`;
}

function formatErrorJson(error) {
  if (!error || typeof error !== 'object') {
    return JSON.stringify({ ok: false, schemaVersion: 1, error: { code: 'CLI_ERROR', message: String(error) } }, null, 2);
  }
  const localized = localizeError(error);
  const payload = {
    ok: false,
    schemaVersion: 1,
    error: {
      code: localized.code,
      message: localized.message || localized.code,
    },
  };
  if (localized.action) payload.error.action = localized.action;
  if (localized.reason) payload.error.reason = localized.reason;
  if (localized.step) payload.error.step = localized.step;
  if (localized.requestId) payload.error.requestId = localized.requestId;
  if (typeof localized.retryable === 'boolean') payload.error.retryable = localized.retryable;
  if (localized.details) payload.error.details = localized.details;
  return JSON.stringify(payload, null, 2);
}

function localizeError(error) {
  const rawCode = error.code || error.message || 'CLI_ERROR';
  const code = rawCode.startsWith('UNKNOWN_COMMAND:') ? 'UNKNOWN_COMMAND' : rawCode;
  const command = rawCode.startsWith('UNKNOWN_COMMAND:') ? rawCode.slice('UNKNOWN_COMMAND:'.length) : '';
  const known = {
    PAGES_CREDENTIAL_REQUIRED: {
      message: '缺少 Pages 登录凭证。',
      action: '请先运行 xd-cell login，或设置 XD_CELL_API_TOKEN；短期受控场景也可以显式传 --token <token>。',
    },
    SITE_REQUIRED: {
      message: '缺少站点名。',
      action: localizedAction(error, '请传入站点名，例如 xd-cell deploy ./dist demo。'),
    },
    SITE_SLUG_REQUIRED: {
      message: '缺少站点名。',
      action: localizedAction(error, '请传入站点名，例如 xd-cell deploy ./dist demo。'),
    },
    SITE_NOT_FOUND: {
      message: error.message && /^未找到/.test(error.message) ? error.message : '未找到站点。',
      action: localizedAction(error, '请确认站点名和站点权限；如果使用 API token，请确认它绑定的是这个站点。'),
    },
    SITE_VISIBILITY_INVALID: {
      message: '站点可见性无效。',
      action: '请使用 internal、org、acl、owner 或 disabled。',
    },
    VERSION_REQUIRED: {
      message: '缺少版本 ID。',
      action: '当前 CLI 不支持 rollback 命令；如需回滚请联系平台维护者。',
    },
    SITE_BINDING_REQUIRED: {
      message: '缺少站点名。',
      action: '请显式传入站点名。',
    },
    ENV_COMMAND_INVALID: {
      message: 'env 命令不完整或无效。',
      action: '当前 CLI 不支持切换发布环境；请检查配置或联系平台维护者。',
    },
    UNKNOWN_COMMAND: {
      message: command ? `未知命令：${command}` : '未知命令。',
      action: '运行 xd-cell help 查看可用命令。',
    },
  };
  const translated = known[code];
  if (translated) return { code, ...translated, ...readPublicDiagnostics(error) };
  return {
    code,
    message: error.message || code,
    action: error.action,
    ...readPublicDiagnostics(error),
  };
}

function localizedAction(error, fallback) {
  return error.action && /[\u4e00-\u9fff]/.test(error.action) ? error.action : fallback;
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
