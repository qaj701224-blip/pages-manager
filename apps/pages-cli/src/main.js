#!/usr/bin/env node
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
    write(stderr, `${formatError(error)}\n`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
