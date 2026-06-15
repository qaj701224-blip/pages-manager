#!/usr/bin/env node
import { parseArgs } from './args.js';
import { readCliConfig } from './config.js';

export async function main(argv = process.argv.slice(2), io = {}) {
  const stderr = io.stderr || process.stderr;
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      write(stderr, 'Usage: pages <command> [options]\n');
      return 0;
    }
    readCliConfig(process.env, { environment: parsed.flags.env });
    write(stderr, `Command not implemented yet: ${parsed.command}\n`);
    return 1;
  } catch (error) {
    write(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function write(stream, text) {
  if (typeof stream?.write === 'function') stream.write(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
