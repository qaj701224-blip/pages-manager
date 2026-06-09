import {
  buildManifest,
  registerUploadSession,
  uploadAssetBuckets,
  deployScript,
  bindRoute,
  enableSubdomain,
} from '../lib/cf-api.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const VALID_PRESETS = ['static', 'spa', 'worker'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleDeploy(request, env) {
  const form = await request.formData();

  const name = form.get('name');
  if (!name || !NAME_RE.test(name)) {
    return json(
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

  const userToken = request.headers.get('X-Pages-Token') || form.get('token') || null;
  const ipRestrict = form.get('ip_restrict') !== 'false';

  const preset = form.get('preset') || 'static';
  if (!VALID_PRESETS.includes(preset)) {
    return json(
      {
        error: '无效的 preset',
        field: 'preset',
        value: preset,
        valid: VALID_PRESETS,
      },
      400
    );
  }

  let workerCode = null;
  const fileEntries = [];
  for (const [key, value] of form.entries()) {
    if (key === 'name' || key === 'preset' || key === 'ip_restrict' || key === 'token') continue;
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
    return json(
      {
        error: '缺少 _worker.js',
        field: 'files',
        hint: '使用 worker preset 时，上传文件中必须包含 filename=_worker.js 的文件作为 Worker 入口',
      },
      400
    );
  }
  if (fileEntries.length === 0 && preset !== 'worker') {
    return json(
      {
        error: '未收到文件',
        field: 'files',
        hint: '至少上传一个文件，使用 multipart/form-data 格式，文件字段名任意，filename 参数为文件相对路径',
      },
      400
    );
  }

  const existing = await env.SITES.get(name, 'json');
  const forceOverwrite = form.get('force') === 'true';
  if (existing && existing.token && userToken && existing.token !== userToken && !forceOverwrite) {
    return json(
      {
        error: '站点名称已被占用',
        field: 'name',
        name,
        owner: existing.token,
        hint: `该名称已被 ${existing.token} 使用，请换一个名称，或传 force=true 强制覆盖`,
      },
      409
    );
  }

  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  const zoneId = env.CF_ZONE_ID_NEW;
  const scriptName = `${env.WORKER_PREFIX}${name}`;
  const hostname = `${name}${env.DOMAIN_LABEL}.${env.DOMAIN_BASE}`;

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
    env.IP_ALLOWLIST
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
    token: userToken,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await env.SITES.put(name, JSON.stringify(metadata), {
    metadata: { url: metadata.url, preset, ipRestrict, updatedAt: now, token: userToken },
  });

  const result = {
    status: 'ok',
    name,
    url: metadata.url,
    devUrl,
    fileCount: fileEntries.length,
    preset,
    ipRestrict,
  };
  const warnings = [];
  if (!userToken) {
    warnings.push(
      '未提供 token。建议设置 X-Pages-Token 请求头（格式: pages_你的邮箱），用于追溯部署记录和查询自己的站点。请让 AI 在本地记住你的 token。'
    );
  }
  if (ipRestrict && preset === 'worker') {
    warnings.push(
      'worker preset 已注入 env.IP_ALLOWLIST，但不会改写 _worker.js。' +
        '请在 _worker.js 中调用 GET /openapi.json 中 x-libs.ip-guard 的 checkIP(request, env)。'
    );
  }
  if (warnings.length) result.warning = warnings.join(' ');
  return json(result);
}
