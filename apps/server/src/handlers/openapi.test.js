import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAPISpec, handleOpenAPI } from './openapi.js';

test('ip-guard helper reads allowlist from worker env', async () => {
  const response = handleOpenAPI();
  const spec = await response.json();
  const ipGuard = spec['x-libs']['ip-guard'];

  assert.equal(ipGuard.usage, 'const blocked = checkIP(request, env); if (blocked) return blocked;');
  assert.match(ipGuard.source, /env\.IP_ALLOWLIST/);
  assert.doesNotMatch(ipGuard.source, /const ALLOWED/);
  assert.doesNotMatch(ipGuard.source, /替换为真实 IP 白名单/);
});

test('staging openapi spec uses staging API and site URLs', () => {
  const spec = buildOpenAPISpec(new Request('https://api-staging.workers.xd.team/openapi.json'), {
    DOMAIN_BASE: 'workers.xd.team',
    DOMAIN_LABEL: '-staging',
    WORKER_PREFIX: 'pages-staging-',
    WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
    PAGES_MANAGER_WORKER_NAME: 'pages-manager-staging',
    PUBLIC_API_BASE: 'https://api-staging.workers.xd.team',
    PUBLIC_ENVIRONMENT: 'staging',
  });
  const body = JSON.stringify(spec);
  const deployScript = spec['x-scripts'].deploy.source;

  assert.equal(spec.servers[0].url, 'https://api-staging.workers.xd.team');
  assert.match(body, /https:\/\/q2-report-staging\.workers\.xd\.team/);
  assert.match(body, /https:\/\/pages-staging-q2-report\.xd-cf-2022\.workers\.dev/);
  assert.match(deployScript, /API="\$\{PAGES_API:-https:\/\/api-staging\.workers\.xd\.team\}"/);
  assert.doesNotMatch(body, /https:\/\/api\.workers\.xd\.team/);
  assert.doesNotMatch(body, /https:\/\/q2-report\.workers\.xd\.team/);
});

test('openapi response is not cached because it contains environment-specific scripts', () => {
  const response = handleOpenAPI(new Request('https://api-staging.workers.xd.team/openapi.json'), {
    PUBLIC_API_BASE: 'https://api-staging.workers.xd.team',
    PUBLIC_ENVIRONMENT: 'staging',
  });

  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('openapi documents deploy token as required', () => {
  const spec = buildOpenAPISpec(new Request('https://api.workers.xd.team/openapi.json'), {});
  const body = JSON.stringify(spec);
  const deploy = spec.paths['/deploy'].post;
  const formSchema = deploy.requestBody.content['multipart/form-data'].schema;
  const tokenParameter = deploy.parameters.find((parameter) => parameter.$ref === '#/components/parameters/PagesToken');
  const deployScript = String(spec['x-scripts'].deploy.source);

  assert.ok(tokenParameter);
  assert.equal(spec.components.parameters.PagesToken.required, true);
  assert.match(formSchema.properties.token.description, /备选方式/);
  assert.match(deployScript, /if \[ -z "\$\{PAGES_TOKEN:-\}" \]; then/);
  assert.match(deployScript, /-H "X-Pages-Token: \$\{PAGES_TOKEN\}"/);
  assert.doesNotMatch(deployScript, /if \[ -n "\$\{PAGES_TOKEN:-\}" \]; then/);
  assert.match(body, /部署必须携带/);
  assert.match(body, /同一 token 可覆盖/);
  assert.match(body, /409/);
  assert.doesNotMatch(body, /同名站点可直接覆盖部署/);
  assert.doesNotMatch(body, /未提供 token.*部署仍会成功/);
  assert.equal(deploy.responses[200].content['application/json'].schema.$ref, '#/components/schemas/DeployResult');
  assert.equal(deploy.responses[200].content['application/json'].examples.withoutToken, undefined);
});

test('manage list script requires token and fails on non-200 responses', () => {
  const spec = buildOpenAPISpec(new Request('https://api.workers.xd.team/openapi.json'), {});
  const manageScript = spec['x-scripts'].manage.source;

  assert.match(manageScript, /if \[ -z "\$\{PAGES_TOKEN:-\}" \]; then/);
  assert.match(manageScript, /RESPONSE=\$\(curl -s "\$\{TOKEN_HEADER\[@\]\}" -w "\\n%\{http_code\}" "\$\{API\}\/list"\)/);
  assert.match(manageScript, /HTTP_CODE=\$\(echo "\$RESPONSE" \| tail -1\)/);
  assert.match(manageScript, /查询失败/);
});
