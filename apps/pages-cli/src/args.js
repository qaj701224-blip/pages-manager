const BOOLEAN_FLAGS = new Set(['no-open', 'print', 'json', 'help', 'save-config', 'details', 'dry-run', 'stdin', 'yes']);

export function parseArgs(argv = []) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { command: 'help', positional: [], flags: {} };
  }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    return { command: 'version', positional: [], flags: {} };
  }

  const [command = 'help', ...rest] = argv;
  const positional = [];
  const flags = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--') {
      positional.push(...rest.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    if (token === '-h') {
      setFlag(flags, 'help', true);
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`未知选项：${token}`);

    const option = token.slice(2);
    const [rawName, inlineValue] = option.split(/=(.*)/s, 2);
    const name = normalizeFlagName(rawName);
    const kebabName = rawName.trim();
    if (!kebabName) throw new Error(`未知选项：${token}`);

    if (BOOLEAN_FLAGS.has(kebabName)) {
      setFlag(flags, name, true);
      continue;
    }

    const value = inlineValue !== undefined ? inlineValue : rest[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`选项 --${kebabName} 需要一个值。`);
    }
    if (inlineValue === undefined) index += 1;
    setFlag(flags, name, value);
  }

  return { command, positional, flags };
}

function setFlag(flags, name, value) {
  if (Object.hasOwn(flags, name)) {
    const existing = flags[name];
    flags[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    return;
  }
  flags[name] = value;
}

function normalizeFlagName(name) {
  return name.trim().replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}
