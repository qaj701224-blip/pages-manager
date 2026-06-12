import { parseKvEnabled } from '@xd/pages-runtime-protocol';
import { jsonResponse } from '@xd/worker-kit';

import {
  buildManifest,
  registerUploadSession,
  uploadAssetBuckets,
  deployScript,
  bindRoute,
  enableSubdomain,
} from '../lib/cf-api.js';
import { signKvCapability } from '../lib/kv-capability.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const VALID_PRESETS = ['static', 'spa', 'worker'];

export async function handleDeploy(request, env) {
  const form = await request.formData();

  const name = form.get('name');
  if (!name || !NAME_RE.test(name)) {
    return jsonResponse(
      {
        error: '无效的站点名称',
        field: 'name',
        value: name || null,
        constraint: '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$',
        hint: '仅限小写字母、数字、连字符，2-50 字符，首尾不能是连字符',
      },
      400
    );
  }

  const tokenValue = request.headers.get('X-Pages-Token') || form.get('token') || '';
  const userToken = typeof tokenValue === 'string' ? tokenValue.trim() : '';
  if (!userToken) {
    return jsonResponse(
      {
        error: '缺少部署者 token',
        field: 'token',
        hint: '请通过 X-Pages-Token 请求头或 token 表单字段提供部署者 token',
      },
      400
    );
  }

  const ipRestrict = form.get('ip_restrict') !== 'false';

  const preset = form.get('preset') || 'static';
  if (!VALID_PRESETS.includes(preset)) {
    return jsonResponse(
      {
        error: '无效的 preset',
        field: 'preset',
        value: preset,
        valid: VALID_PRESETS,
      },
      400
    );
  }

  const kvValue = form.get('kv');
  const kv = parseKvEnabled(kvValue);
  if (kv.error) {
    return jsonResponse(
      {
        error: '无效的 kv 参数',
        field: 'kv',
        value: kvValue,
        hint: 'kv 仅支持 true 或 false',
      },
      400
    );
  }

  let workerCode = null;
  const fileEntries = [];
  for (const [key, value] of form.entries()) {
    if (key === 'name' || key === 'preset' || key === 'ip_restrict' || key === 'token' || key === 'kv') continue;
    if (!(value instanceof File)) continue;
    const bytes = new Uint8Array(await value.arrayBuffer());
    const path = value.name || key;
    if (path === '_worker.js' && preset === 'worker') {
      workerCode = new TextDecoder().decode(bytes);
      continue;
    }
    fileEntries.push({ path, bytes });
  }

  if (preset === 'worker' && !workerCode) {
    return jsonResponse(
      {
        error: '缺少 _worker.js',
        field: 'files',
        hint: '使用 worker preset 时，上传文件中必须包含 filename=_worker.js 的文件作为 Worker 入口',
      },
      400
    );
  }
  if (fileEntries.length === 0 && preset !== 'worker') {
    return jsonResponse(
      {
        error: '未收到文件',
        field: 'files',
        hint: '至少上传一个文件，使用 multipart/form-data 格式，文件字段名任意，filename 参数为文件相对路径',
      },
      400
    );
  }

  const existing = await env.SITES.get(name, 'json');
  if (existing && existing.token && existing.token !== userToken) {
    return jsonResponse(
      {
        error: '站点名称已被占用',
        field: 'name',
        name,
        hint: '该名称已被其他部署者使用，请换一个名称或使用原 token',
      },
      409
    );
  }

  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const zoneId = env.CF_ZONE_ID_NEW;
  const scriptName = `${env.WORKER_PREFIX}${name}`;
  const hostname = `${name}${env.DOMAIN_LABEL}.${env.DOMAIN_BASE}`;
  const siteUuid = existing?.siteUuid || crypto.randomUUID().replaceAll('-', '');
  const siteGeneration = Number(existing?.siteGeneration || 0) + 1;
  const kvOptions = {};

  if (kv.enabled) {
    kvOptions.kv = {
      enabled: true,
      gatewayService: env.KV_GATEWAY_SERVICE,
      siteId: name,
      siteUuid,
      envName: env.PUBLIC_ENVIRONMENT,
      capability: await signKvCapability(
        {
          siteId: name,
          siteUuid,
          siteGeneration,
          envName: env.PUBLIC_ENVIRONMENT,
          now: Math.floor(Date.now() / 1000),
          jti: `cap_${crypto.randomUUID().replaceAll('-', '')}`,
        },
        env
      ),
    };
  }

  const { manifest, fileMap } = await buildManifest(fileEntries);

  const session = await registerUploadSession(token, accountId, scriptName, manifest);
  console.log('session:', JSON.stringify({ jwt: session.jwt?.slice(0, 20), buckets: session.buckets?.length }));

  let completionJwt;
  if (session.buckets && session.buckets.length > 0) {
    completionJwt = await uploadAssetBuckets(session.jwt, accountId, session.buckets, fileMap);
    console.log('upload completionJwt:', completionJwt?.slice(0, 20));
  } else {
    completionJwt = session.jwt;
    console.log('no buckets, using session jwt');
  }

  const deployResult = await deployScript(
    token,
    accountId,
    scriptName,
    completionJwt,
    preset,
    workerCode,
    ipRestrict,
    env.IP_ALLOWLIST,
    kvOptions
  );
  console.log('deploy result:', JSON.stringify(deployResult)?.slice(0, 200));

  await bindRoute(token, zoneId, `${hostname}/*`, scriptName);

  await enableSubdomain(token, accountId, scriptName).catch(() => {});

  const workersDev = env.WORKERS_DEV_SUBDOMAIN;
  const devUrl = workersDev ? `https://${scriptName}.${workersDev}.workers.dev` : null;

  const now = new Date().toISOString();
  const metadata = {
    name,
    preset,
    scriptName,
    url: `https://${hostname}`,
    devUrl,
    fileCount: fileEntries.length,
    ipRestrict,
    kvEnabled: kv.enabled,
    siteUuid,
    siteGeneration,
    token: userToken,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await env.SITES.put(name, JSON.stringify(metadata), {
    metadata: {
      url: metadata.url,
      preset,
      ipRestrict,
      kvEnabled: kv.enabled,
      siteUuid,
      siteGeneration,
      updatedAt: now,
      token: userToken,
    },
  });

  const result = {
    status: 'ok',
    name,
    url: metadata.url,
    devUrl,
    fileCount: fileEntries.length,
    preset,
    ipRestrict,
    kv: kv.enabled,
  };
  const warnings = [];
  if (ipRestrict && preset === 'worker') {
    warnings.push(
      'worker preset 已注入 env.IP_ALLOWLIST，但不会改写 _worker.js。' +
        '请在 _worker.js 中调用 GET /openapi.json 中 x-libs.ip-guard 的 checkIP(request, env)。'
    );
  }
  if (kv.enabled && preset === 'worker') {
    warnings.push(
      'worker preset 开启 kv=true 后，_worker.js 会收到本站 KV capability。' +
        '如果代码 import @xd/pages-sdk/worker，必须在上传前完成打包；' +
        '平台无法阻止站点 owner 代码暴露自己的 KV capability。'
    );
  }
  if (warnings.length) result.warning = warnings.join(' ');
  return jsonResponse(result);
}
