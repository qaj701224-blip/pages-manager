import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/acr-write-docker-config.sh');

test('acr docker config helper avoids Aliyun CLI and does not print credentials', async () => {
  const script = readFileSync(scriptPath, 'utf8');

  await access(scriptPath, constants.X_OK);
  assert.equal(statSync(scriptPath).isFile(), true);
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /Action=GetAuthorizationToken/);
  assert.match(script, /Version=2018-12-01/);
  assert.match(script, /ALIYUN_ACCESS_KEY_ID/);
  assert.match(script, /ALIYUN_ACCESS_KEY_SECRET/);
  assert.match(script, /ACR_ACCESS_KEY_ID/);
  assert.match(script, /ACR_ACCESS_KEY_SECRET/);
  assert.match(script, /ACR_OPENAPI_ENDPOINT:-cr\.\$\{ACR_REGION\}\.aliyuncs\.com/);
  assert.match(script, /DOCKER_CONFIG/);
  assert.match(script, /AuthorizationToken/);
  assert.match(script, /<redacted>/);
  assert.doesNotMatch(script, /\baliyun\b/);
  assert.doesNotMatch(script, /docker login/);
  assert.doesNotMatch(script, /echo "\$request_url"|echo "\$\{request_url\}"/);
});

test('acr docker config helper percent-encodes the signed request URL', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pages-acr-auth-'));
  try {
    const binDir = join(tempRoot, 'bin');
    const homeDir = join(tempRoot, 'home');
    const capturedUrlPath = join(tempRoot, 'curl-url.txt');
    mkdirSync(binDir);
    mkdirSync(homeDir);

    const fakeCurlPath = join(binDir, 'curl');
    writeFileSync(
      fakeCurlPath,
      `#!/bin/sh
set -eu
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      out="$1"
      ;;
    -*)
      ;;
    *)
      url="$1"
      ;;
  esac
  shift
done
printf '%s\\n' "$url" > "$FAKE_CURL_CAPTURE"
printf '%s\\n' '{"TempUsername":"temp-user","AuthorizationToken":"temp-token"}' > "$out"
`
    );
    chmodSync(fakeCurlPath, 0o755);

    const result = spawnSync(scriptPath, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        HOME: homeDir,
        ACR_ACCESS_KEY_ID: 'key id/one',
        ACR_ACCESS_KEY_SECRET: 'secret&value',
        ACR_INSTANCE_ID: 'cri-test/id',
        ACR_REGISTRY: 'registry.example.com',
        ACR_REGION: 'cn-shanghai',
        FAKE_CURL_CAPTURE: capturedUrlPath,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const capturedUrl = readFileSync(capturedUrlPath, 'utf8');
    assert.match(capturedUrl, /AccessKeyId=key%20id%2Fone/);
    assert.match(capturedUrl, /InstanceId=cri-test%2Fid/);
    assert.doesNotMatch(capturedUrl, /\\x[0-9A-Fa-f]{2}/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /secret&value|key id\/one|temp-token/);

    const dockerConfig = readFileSync(join(homeDir, '.docker/config.json'), 'utf8');
    assert.match(dockerConfig, /registry\.example\.com/);
    assert.match(dockerConfig, /dGVtcC11c2VyOnRlbXAtdG9rZW4=/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
