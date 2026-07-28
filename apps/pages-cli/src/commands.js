import { parseArgs } from './args.js';
import { loadProfile, resolveProfileDir } from './profile.js';
import { runAccess } from './commands/access.js';
import { runAuth, runAuthLogout, runLogin, runWhoami } from './commands/auth.js';
import { runDeploy, runDetect } from './commands/deploy.js';
import { runEnv } from './commands/env.js';
import { runSecrets } from './commands/secrets.js';
import { runSites } from './commands/sites.js';
import { runOpen, runStatus } from './commands/status-open.js';
import {
  assertNoPositionals,
  assertTokenNotUsed,
  createOutput,
  outputHelp,
  readCliVersion,
  validateCommandUsage,
} from './commands/shared.js';
import { runTeams } from './commands/teams.js';

export { listFixedEnvironments } from './commands/env.js';

export async function executeCommand(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  validateCommandUsage(parsed);
  const output = options.output || createOutput(options.stdout);
  if (parsed.command === 'help' || parsed.flags.help) {
    assertTokenNotUsed(parsed);
    outputHelp(parsed, output);
    return 0;
  }
  if (parsed.command === 'version') {
    assertTokenNotUsed(parsed);
    assertNoPositionals(parsed, 'VERSION_USAGE_INVALID', 'xd-cell version 不接受位置参数。');
    output(await readCliVersion());
    return 0;
  }

  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const profileDir = options.profileDir || resolveProfileDir({ env, platform: options.platform, homedir: options.homedir });
  const profile = options.profile || (await loadProfile(profileDir));

  switch (parsed.command) {
    case 'login':
      return runLogin(parsed, { ...options, env, profileDir, profile, output });
    case 'auth':
      return runAuth(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'whoami':
      return runWhoami(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'logout':
      return runAuthLogout(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'deploy':
      return runDeploy(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'detect':
      return runDetect(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'secrets':
      return runSecrets(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'status':
      return runStatus(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'open':
      return runOpen(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'sites':
      return runSites(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'teams':
      return runTeams(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'access':
      return runAccess(parsed, { ...options, cwd, env, profileDir, profile, output });
    case 'env':
      return runEnv(parsed, { ...options, cwd, env, profileDir, profile, output });
    default:
      throw new Error(`UNKNOWN_COMMAND:${parsed.command}`);
  }
}
