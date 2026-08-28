import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function section(doc, startHeading, endHeading) {
  const start = doc.indexOf(startHeading);
  const end = endHeading === undefined ? doc.length : doc.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `${startHeading} should exist`);
  if (endHeading !== undefined) assert.notEqual(end, -1, `${endHeading} should exist`);
  return doc.slice(start, end);
}

test('docs/api-boundary.md documents API boundary without duplicating CLI guide', () => {
  const api = readDoc('docs/api-boundary.md');

  assert.match(api, /CLI-managed API/);
  assert.match(api, /apps\/pages-api\/src\/openapi\.js/);
  assert.match(api, /不公开 `\/openapi\.json`/);
  assert.match(api, /不是 endpoint reference|不是 CLI 使用指南/);
  assert.match(api, /apps\/server\/README\.md/);
  assert.doesNotMatch(api, /xd-cell detect \.\/dist --json/);
  assert.doesNotMatch(api, /xd-cell deploy \.\/dist demo --dry-run --json/);
  assert.doesNotMatch(api, /"worker": \{/);
  assert.doesNotMatch(api, /fallback` 表达|fallback` 可取/);
  assert.doesNotMatch(api, /### POST|### GET|### ACL/);
  assert.doesNotMatch(api, /X-Pages-Token/);
  assert.doesNotMatch(api, /preset/);
  assert.doesNotMatch(api, /api\.workers\.xd\.team/);
});

test('API boundary defines Public Sites as an authenticated minimal directory', () => {
  const api = readDoc('docs/api-boundary.md');
  const publicSites = section(api, '## Public Sites 目录边界', '## 站点名称与 URL');

  assert.match(publicSites, /必须认证的站点发现目录/);
  assert.match(publicSites, /`public`[^\n]*Public API lane[^\n]*不表示匿名访问[^\n]*`exposure=public`/);
  assert.match(publicSites, /固定查询当前 API Worker 环境/);
  assert.match(publicSites, /active 人类用户上下文[^\n]*`read:site`/);
  assert.match(publicSites, /Cindy connection assertion[^\n]*CLI 登录凭证[^\n]*个人 Access Key/);
  assert.match(publicSites, /`deploy:site`[^\n]*Team Access Key[^\n]*site-scoped key[^\n]*不得枚举目录/);
  assert.match(publicSites, /`users`[^\n]*身份与部门真相源/);
  assert.match(publicSites, /不信任 Cindy assertion[^\n]*role[^\n]*department[^\n]*identities claim/);
  assert.match(publicSites, /active-only minimal projection/);
  assert.match(publicSites, /`owner` 只暴露 `type=user\|team`/);
  assert.match(publicSites, /不返回 owner identity、ACL 条目、route\/version、runtime、provider/);
  assert.match(publicSites, /apps\/pages-api\/src\/openapi\.js[^\n]*开发期合约源码/);
  assert.doesNotMatch(publicSites, /### (?:GET|POST|PATCH|DELETE)|\|\s*Method\s*\|\s*Path\s*\|/);
});

test('API boundary documents the current site name and URL contract without thumbnail scope', () => {
  const api = readDoc('docs/api-boundary.md');

  assert.match(api, /`PATCH \/\.xd-pages\/api\/sites\/\{id\}\/metadata`/);
  assert.match(api, /`title: null`/);
  assert.match(api, /`displayName`/);
  assert.match(api, /部署 multipart metadata[^。\n]*显式传 `title`/);
  assert.match(api, /省略时不修改既有站点名称/);
  assert.match(api, /当前 `xd-cell` CLI 不发送 `title`/);
  assert.match(api, /旧 URL 不跳转/);
  assert.match(api, /5 分钟安全期/);
  assert.match(api, /Public API mutation[^。\n]*`deploy:site`[^。\n]*`404 SITE_NOT_FOUND`/);
  assert.match(api, /Workspace Console[^。\n]*publisher\/admin[^。\n]*`403 SITE_PUBLISHER_REQUIRED`/);
  assert.match(api, /Admin Console[^。\n]*platform admin[^。\n]*不要求站点成员关系/);
  assert.match(api, /含 `slug` 的 mutation[^。\n]*`202`[^。\n]*`routingStatus: pending`/);
  assert.match(api, /title-only[^。\n]*`200`[^。\n]*`routingStatus: pending`/);
  assert.match(api, /`SITE_METADATA_MUTATIONS_ENABLED`/);
  assert.match(api, /缩略图上传与托管延期/);
  assert.match(api, /不为该能力新增 R2 binding/);
});

test('public docs recommend xd-cell CLI instead of legacy deploy curl', () => {
  const docs = [readDoc('README.md'), readDoc('pages-deploy.skill.md')].join('\n');

  assert.match(docs, /xd-cell deploy \.\/dist demo/);
  assert.match(docs, /xd-cell detect \.\/dist --json/);
  assert.doesNotMatch(docs, /curl -X POST https:\/\/api\.workers\.xd\.team\/deploy/);
  assert.doesNotMatch(docs, /X-Pages-Token/);
});

test('README deploy examples use xd-cell CLI and automatic detection', () => {
  const readme = readDoc('README.md');

  assert.match(readme, /xd-cell deploy \.\/dist demo --visibility org/);
  assert.match(readme, /xd-cell deploy --config xd-cell\.config\.json/);
  assert.match(readme, /assets\.not_found_handling/);
  assert.match(readme, /"main": "\.\/src\/index\.js"/);
  assert.match(readme, /"assets": \{/);
  assert.match(readme, /"vars": \{/);
  assert.doesNotMatch(readme, /PAGES_TOKEN/);
  assert.doesNotMatch(readme, /--preset/);
  assert.doesNotMatch(readme, /artifactKind/);
  assert.doesNotMatch(readme, /"worker": \{|pages\.config\.json|--fallback </);
});

test('public docs describe config discovery without platform internals', () => {
  const docs = [
    ['README.md', section(readDoc('README.md'), '## 用户入口', '## 安全边界')],
    ['pages-deploy.skill.md', readDoc('pages-deploy.skill.md')],
  ];

  for (const [name, doc] of docs) {
    assert.match(doc, /xd-cell\.config\.json/, `${name} mentions the standard config file`);
    assert.doesNotMatch(doc, /pages\.config\.json/, `${name} does not mention the old config file`);
    assert.doesNotMatch(doc, /不自动发现/, `${name} does not contradict config auto-discovery`);
    assert.doesNotMatch(doc, /--access-key|--env|xd-cell env|"environment"/, `${name} keeps hidden options out of user docs`);
    assert.doesNotMatch(
      doc,
      /artifactKind|--artifact-kind|--preset|\bpreset\b/,
      `${name} avoids artifact-kind and preset vocabulary`
    );
    assert.doesNotMatch(doc, /WFP|slot|dispatch namespace|service binding/i, `${name} avoids platform internals`);
  }
});

test('each public doc says v1 Pages KV is retired and avoids private capability text', () => {
  const docs = [
    ['README.md', readDoc('README.md')],
    ['pages-deploy.skill.md', readDoc('pages-deploy.skill.md')],
  ];

  for (const [name, doc] of docs) {
    assert.match(doc, /旧版 Pages KV 已退休|runtime helper 或 KV/, `${name} documents old KV retirement`);
    assert.doesNotMatch(doc, /KV 能力.*平台规划|后续 v2 `pages\.xd\.team`/, `${name} does not describe KV as future-only`);
    assert.doesNotMatch(doc, /static \+ kv=true/, `${name} no longer documents v1 static KV rejection`);
    assert.doesNotMatch(doc, /\/\.xd-pages\/runtime\/v1/, `${name} does not document retired runtime path`);
    assert.doesNotMatch(doc, /@xd\/pages-sdk/, `${name} does not document retired pages-sdk package`);
    assert.doesNotMatch(doc, /@xd-pages\/worker-sdk\/browser/, `${name} does not document retired browser SDK entry`);
    assert.doesNotMatch(doc, /@xd-pages\/worker-sdk\/worker/, `${name} does not document retired worker SDK entry`);

    assert.doesNotMatch(doc, /PAGES_CAP_JWT_SECRET/, `${name} does not mention internal JWT secret env`);
    assert.doesNotMatch(doc, /SITE_DATA_KV_NAMESPACE_ID/, `${name} does not mention platform KV namespace env`);
    assert.doesNotMatch(doc, /capability\.jwt/, `${name} does not include capability example`);
  }
});

test('README local deployment commands use package scripts or wrangler directly', () => {
  const readme = readDoc('README.md');

  assert.doesNotMatch(readme, /JWT_SIGNING_SECRET_ENV=PAGES_CAP_JWT_SECRET_EXAMPLE/);
  assert.doesNotMatch(readme, /JWT_SIGNING_SECRET_ENV=JWT_SIGNING_SECRET_EXAMPLE/);
  assert.doesNotMatch(readme, /PAGES_CAP_JWT_ACTIVE_KID=prod-hs-example/);
  assert.doesNotMatch(readme, /export PAGES_CAP_JWT_ACTIVE_KID/);
  assert.doesNotMatch(readme, /pnpm --dir apps\/kv-gateway exec wrangler deploy/);
  assert.match(readme, /pnpm --dir apps\/pages-api test/);
  assert.doesNotMatch(readme, /pnpm --dir apps\/server deploy\b/);
  assert.doesNotMatch(readme, /scripts\/put-capability-secrets\.sh apps\/server/);
  assert.doesNotMatch(readme, /pnpm --dir apps\/kv-gateway deploy/);
});

test('published SDK README does not demonstrate bypassing runtime access checks', () => {
  const sdkReadme = readDoc('apps/worker-sdk/README.md');

  assert.doesNotMatch(sdkReadme, /checkAccess:\s*\(\)\s*=>\s*null/);
  assert.match(sdkReadme, /^# @xd-cell\/worker-sdk/m);
  assert.match(sdkReadme, /pnpm add @xd-cell\/worker-sdk/);
  assert.match(sdkReadme, /from '@xd-cell\/worker-sdk'/);
  assert.match(sdkReadme, /Cloudflare API 心智/);
  assert.match(sdkReadme, /runtime\.kv\.get/);
  assert.match(sdkReadme, /runtime\.kv\.put/);
  assert.match(sdkReadme, /D1\/R2 公开前/);
  assert.match(sdkReadme, /skill 不复制 Worker SDK 领域产物/);
  assert.doesNotMatch(sdkReadme, /@xd-pages\/sdk\/worker/);
  assert.doesNotMatch(sdkReadme, /createPagesRuntime/);
  assert.doesNotMatch(sdkReadme, /readPlatformContext/);
  assert.doesNotMatch(sdkReadme, /只暴露 `\.\/worker` export/);
  assert.doesNotMatch(sdkReadme, /handlePagesRuntimeRequest/);
  assert.doesNotMatch(sdkReadme, /Runtime adapter（运行时适配器）/);
});

test('Worker SDK AI-readable docs are generated from package truth sources', () => {
  const workerDoc = readDoc('apps/worker-sdk/docs/llms/worker-sdk.md');
  const apiDoc = readDoc('apps/worker-sdk/docs/llms/worker-sdk-api.md');
  const index = readDoc('llms.txt');
  const breakingChanges = readDoc('apps/worker-sdk/BREAKING_CHANGES.md');

  assert.match(workerDoc, /^# @xd-cell\/worker-sdk/m);
  assert.match(workerDoc, /生成来源/);
  assert.match(workerDoc, /skill 不复制 Worker SDK 领域产物/);
  assert.match(workerDoc, /from '@xd-cell\/worker-sdk'/);
  assert.match(workerDoc, /Cloudflare API 心智/);
  assert.match(workerDoc, /runtime\.kv\.get/);
  assert.match(workerDoc, /runtime\.kv\.put/);
  assert.match(workerDoc, /runtime\.kv\.getWithMetadata/);
  assert.match(workerDoc, /runtime\.kv\.list/);
  assert.match(workerDoc, /未实现的 D1\/R2 空壳 API/);
  assert.match(workerDoc, /安全约束/);
  assert.match(workerDoc, /非目标/);
  assert.match(workerDoc, /BREAKING_CHANGES\.md/);
  assert.match(workerDoc, /默认按 text/);
  assert.doesNotMatch(workerDoc, /src\/worker\/runtime\.ts|capability\.jwt|PAGES_CAP_JWT_SECRET/);
  assert.doesNotMatch(workerDoc, /createPagesRuntime|readPlatformContext|runtime\.data|kv\.site|kv\.user/);

  assert.match(apiDoc, /^# @xd-cell\/worker-sdk API/m);
  assert.match(apiDoc, /createRuntime/);
  assert.match(apiDoc, /export declare function createRuntime/);
  assert.match(apiDoc, /readContext/);
  assert.match(apiDoc, /export declare function readContext/);
  assert.match(apiDoc, /SDKError/);
  assert.match(apiDoc, /export declare class SDKError/);
  assert.match(apiDoc, /export interface RuntimeEnv/);
  assert.match(apiDoc, /export interface Runtime/);
  assert.match(apiDoc, /export interface KVNamespace/);
  assert.match(apiDoc, /get\(key: string, options\?: \{/);
  assert.match(apiDoc, /getWithMetadata<TMetadata = unknown>/);
  assert.match(apiDoc, /list<TMetadata = unknown>/);
  assert.match(apiDoc, /export interface KVPutOptions/);
  assert.match(apiDoc, /expiration\?: number/);
  assert.match(apiDoc, /metadata\?: TMetadata/);
  assert.match(apiDoc, /put<TMetadata = unknown>\(key: string, value: string/);
  assert.doesNotMatch(apiDoc, /capabilities\.ts|gateway\.ts|platform-context\.ts/);
  assert.doesNotMatch(apiDoc, /createPagesRuntime|readPlatformContext|Pages|set\(key|KVResources/);

  assert.match(index, /apps\/worker-sdk\/docs\/llms\/worker-sdk\.md/);
  assert.match(index, /apps\/worker-sdk\/docs\/llms\/worker-sdk-api\.md/);
  assert.match(index, /apps\/worker-sdk\/BREAKING_CHANGES\.md/);
  assert.match(breakingChanges, /无破坏性变更|存在(?:类型级)?破坏性变更/);
});

test('demo README scopes openapi.json references to v1 legacy only', () => {
  const sectionText = section(readDoc('demos/README.md'), '## Worker Preset IP Guard', undefined);

  assert.match(sectionText, /v1 legacy/i);
  assert.match(sectionText, /\/openapi\.json/);
  assert.match(sectionText, /v2[^。\n]*不公开[^。\n]*\/openapi\.json|v2[^.\n]*does not expose[^.\n]*\/openapi\.json/i);
});

test('PR template separates v2 API checks from v1 legacy endpoints', () => {
  const template = readDoc('.github/pull_request_template.md');

  assert.match(template, /v2 `\/\.xd-pages\/api\/\*`/);
  assert.match(template, /CLI token|access key|api_session/);
  assert.match(template, /v1 legacy `\/deploy`、`\/list`、`\/site\/:name`/);
  assert.match(template, /docs\/api-boundary\.md/);
  assert.doesNotMatch(template, /API\.md/);
});
