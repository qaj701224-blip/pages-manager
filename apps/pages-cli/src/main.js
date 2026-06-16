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
  const code = error.code || error.message || 'CLI_ERROR';
  const message = error.message && error.message !== code ? ` ${error.message}` : '';
  const action = error.action ? ` ${error.action}` : '';
  return `${code}${message}${action}`;
}

function formatErrorJson(error) {
  if (!error || typeof error !== 'object') {
    return JSON.stringify({ ok: false, error: { code: 'CLI_ERROR', message: String(error) } });
  }
  const code = error.code || error.message || 'CLI_ERROR';
  const payload = {
    ok: false,
    error: {
      code,
      message: error.message || code,
    },
  };
  if (error.action) payload.error.action = error.action;
  return JSON.stringify(payload);
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
