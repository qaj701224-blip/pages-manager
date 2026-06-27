import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { symlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiError } from './api-client.js';
import { main, readHiddenLine } from './main.js';

test('main dispatches commands and writes stdout', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['help'], {
    stdout,
    stderr,
    env: {},
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /用法：xd-cell/);
  assert.equal(stderr.text(), '');
});

test('main returns non-zero safe errors for unknown commands', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['missing'], {
    stdout,
    stderr,
    env: {},
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /UNKNOWN_COMMAND/);
  assert.equal(stdout.text(), '');
});

test('main prints API error code, message, and action', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['deploy', '.'], {
    stdout,
    stderr,
    env: {},
    cwd: '/',
    commandRunner: async () => {
      throw new ApiError({
        status: 404,
        code: 'SITE_NOT_FOUND',
        message: 'Site not found.',
        action: 'Check the site id.',
      });
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /SITE_NOT_FOUND/);
  assert.match(stderr.text(), /未找到站点/);
  assert.match(stderr.text(), /确认站点名和站点权限/);
  assert.equal(stdout.text(), '');
});

test('main does not expose env command guidance for environment errors', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['deploy', '.'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      throw new Error('ENV_COMMAND_INVALID');
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /当前 CLI 不支持切换发布环境/);
  assert.doesNotMatch(stderr.text(), /xd-cell env|--env/);
  assert.equal(stdout.text(), '');
});

test('main prints public request diagnostics for API errors', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['login'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      throw new ApiError({
        status: 400,
        code: 'OAUTH_STATE_INVALID',
        message: 'OAuth state is invalid.',
        action: 'Restart login.',
        reason: 'oauth_state_invalid_or_expired',
        step: 'oauth.state',
        requestId: 'req_test_cli',
        retryable: false,
        details: {
          httpStatus: 502,
          providerEndpointType: 'sso_profile',
        },
      });
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /OAUTH_STATE_INVALID/);
  assert.match(stderr.text(), /oauth_state_invalid_or_expired/);
  assert.match(stderr.text(), /req_test_cli/);
  assert.doesNotMatch(stderr.text(), /httpStatus/);
  assert.equal(stdout.text(), '');
});

test('main prints JSON error envelopes when --json is requested', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['deploy', '.', '--json'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      const error = new Error('SITE_SLUG_REQUIRED');
      error.code = 'SITE_SLUG_REQUIRED';
      throw error;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '');
  assert.deepEqual(JSON.parse(stderr.text()), {
    ok: false,
    schemaVersion: 1,
    error: {
      code: 'SITE_SLUG_REQUIRED',
      message: '缺少站点名。',
      action: '请传入站点名，例如 xd-cell deploy ./dist demo。',
    },
  });
});

test('main preserves public diagnostics in JSON error envelopes', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['login', '--json'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      throw new ApiError({
        status: 400,
        code: 'OAUTH_STATE_INVALID',
        message: 'OAuth state is invalid.',
        action: 'Restart login.',
        reason: 'oauth_state_invalid_or_expired',
        step: 'oauth.state',
        requestId: 'req_test_cli',
        retryable: false,
        details: {
          httpStatus: 502,
          providerEndpointType: 'sso_profile',
        },
      });
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '');
  assert.deepEqual(JSON.parse(stderr.text()), {
    ok: false,
    schemaVersion: 1,
    error: {
      code: 'OAUTH_STATE_INVALID',
      message: 'OAuth state is invalid.',
      action: 'Restart login.',
      reason: 'oauth_state_invalid_or_expired',
      step: 'oauth.state',
      requestId: 'req_test_cli',
      retryable: false,
      details: {
        httpStatus: 502,
        providerEndpointType: 'sso_profile',
      },
    },
  });
});

test('main drops unsafe diagnostic details from JSON error envelopes', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['login', '--json'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      throw new ApiError({
        status: 502,
        code: 'SSO_EXCHANGE_FAILED',
        message: 'SSO exchange failed.',
        details: {
          httpStatus: 502,
          providerEndpointType: 'sso_profile',
          redirectUri: 'https://demo.pages.xd.team/callback?token=secret',
          stateAgeBucket: 'expired',
          token: 'secret-token',
        },
      });
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '');
  assert.deepEqual(JSON.parse(stderr.text()).error.details, {
    httpStatus: 502,
    providerEndpointType: 'sso_profile',
  });
  assert.doesNotMatch(stderr.text(), /secret-token/);
  assert.doesNotMatch(stderr.text(), /redirectUri/);
  assert.doesNotMatch(stderr.text(), /stateAgeBucket/);
});

test('main drops non-allowlisted diagnostic reason and step from JSON error envelopes', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['login', '--json'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      const error = new Error('SSO exchange failed.');
      error.code = 'SSO_EXCHANGE_FAILED';
      error.reason = 'https://sso.example.test/oauth/error?token=secret';
      error.step = 'sso.profile.parse';
      error.requestId = 'req_test_cli';
      throw error;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '');
  assert.deepEqual(JSON.parse(stderr.text()), {
    ok: false,
    schemaVersion: 1,
    error: {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
      requestId: 'req_test_cli',
    },
  });
  assert.doesNotMatch(stderr.text(), /secret/);
  assert.doesNotMatch(stderr.text(), /sso\.profile\.parse/);
});

test('main keeps command-specific SITE_REQUIRED actions', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['status'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      const error = new Error('缺少站点名。');
      error.code = 'SITE_REQUIRED';
      error.action = '请使用 xd-cell status <站点名>。';
      throw error;
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /SITE_REQUIRED/);
  assert.match(stderr.text(), /xd-cell status <站点名>/);
  assert.doesNotMatch(stderr.text(), /xd-cell deploy \.\/dist demo/);
});

test('readHiddenLine reads from a TTY without echoing the secret value', async () => {
  const stdin = new FakeTtyInput();
  const stdout = capture();
  const promise = readHiddenLine('Secret value: ', { stdin, stdout });

  stdin.emit('data', Buffer.from('super-secret'));
  stdin.emit('data', Buffer.from([13]));

  assert.equal(await promise, 'super-secret');
  assert.equal(stdout.text(), 'Secret value: \n');
  assert.equal(stdin.rawMode, false);
  assert.equal(stdin.paused, true);
});

test('global symlinked bin invokes the CLI entrypoint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-bin-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const linkPath = path.join(dir, 'xd-cell');
  const mainPath = fileURLToPath(new URL('./main.js', import.meta.url));
  await symlink(mainPath, linkPath);

  const result = await runNode([linkPath, 'help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /用法：xd-cell/);
  assert.equal(result.stderr, '');
});

function capture() {
  let value = '';
  return {
    write(chunk) {
      value += chunk;
    },
    text() {
      return value;
    },
  };
}

class FakeTtyInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawMode = false;
    this.paused = false;
  }

  setRawMode(value) {
    this.rawMode = value;
    this.isRaw = value;
  }

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
