import { jsonResponse } from '@xd/worker-kit';

import {
  buildManifest,
  registerUploadSession,
  uploadAssetBuckets,
  deployScript,
  bindRoute,
  enableSubdomain,
} from '../lib/cf-api.js';
import { isReservedSiteName, RESERVED_SITE_NAMES, SITE_NAME_PATTERN, SITE_NAME_RE } from '../lib/site-names.js';

const VALID_PRESETS = ['static', 'spa', 'worker'];

export async function handleDeploy(request, env) {
  const form = await request.formData();

  const name = form.get('name');
  if (!name || !SITE_NAME_RE.test(name)) {
    return jsonResponse(
      {
        error: '无效的站点名称',
        field: 'name',
        value: name || null,
        constraint: SITE_NAME_PATTERN,
        hint: '仅限小写字母、数字、连字符，2-50 字符，首尾不能是连字符',
      },
      400
    );
  }
  if (isReservedSiteName(name)) {
    return jsonResponse(
      {
        error: '站点名称为平台保留名称',
        field: 'name',
        name,
        reserved: RESERVED_SITE_NAMES,
        hint: '请换一个非平台保留名称',
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

  const ipRestrictValue = form.get('ip_restrict');
  if (ipRestrictValue !== null && ipRestrictValue !== 'true') {
    return jsonResponse(
      {
        error: '当前版本不支持关闭 IP 限制',
        field: 'ip_restrict',
        value: ipRestrictValue,
        hint: '当前版本所有站点请求都必须经过平台 IP 白名单',
      },
      400
    );
  }
  const ipRestrict = true;

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
  if (kvValue !== null && kvValue !== 'true' && kvValue !== 'false') {
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
  if (kvValue === 'true') {
    return jsonResponse(
      {
        error: 'v1 Pages KV 已下线',
        code: 'KV_NOT_SUPPORTED',
        field: 'kv',
        value: kvValue,
        hint: 'v1 workers.xd.team 不再提供 Pages KV；请使用 v2 pages.xd.team 的 KV 能力',
      },
      400
    );
  }
  const kvEnabled = false;

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
  const claim = {
    environment: readPublicEnvironment(env),
    hostname,
    normalizedSlug: name,
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: `v1:${readPublicEnvironment(env)}:${name}`,
    ownerRef: scriptName,
    source: 'v1_deploy',
    status: existing ? 'active' : 'pending',
  };

  const claimResult = await acquireHostnameClaim(env, claim);
  if (!claimResult.ok) {
    return jsonResponse(
      {
        error: '站点域名已被占用',
        code: claimResult.code || 'HOSTNAME_CLAIM_CONFLICT',
        field: 'name',
        name,
        hint: '该站点名已被 v1/v2 其它站点占用，请换一个名称或使用原站点 owner 继续部署',
      },
      409
    );
  }

  let metadata;
  let metadataWritten = false;
  try {
    const { manifest, fileMap } = await buildManifest(fileEntries);

    const session = await registerUploadSession(token, accountId, scriptName, manifest);
    console.log('upload session:', JSON.stringify({ buckets: session.buckets?.length || 0 }));

    let completionJwt;
    if (session.buckets && session.buckets.length > 0) {
      completionJwt = await uploadAssetBuckets(session.jwt, accountId, session.buckets, fileMap);
      console.log('asset buckets uploaded:', JSON.stringify({ buckets: session.buckets.length }));
    } else {
      completionJwt = session.jwt;
      console.log('asset buckets skipped:', JSON.stringify({ buckets: 0 }));
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
    console.log('deploy result:', JSON.stringify({ ok: Boolean(deployResult) }));

    await bindRoute(token, zoneId, `${hostname}/*`, scriptName);

    await enableSubdomain(token, accountId, scriptName).catch(() => {});

    const workersDev = env.WORKERS_DEV_SUBDOMAIN;
    const devUrl = workersDev ? `https://${scriptName}.${workersDev}.workers.dev` : null;

    const now = new Date().toISOString();
    metadata = {
      name,
      preset,
      scriptName,
      url: `https://${hostname}`,
      devUrl,
      fileCount: fileEntries.length,
      ipRestrict,
      kvEnabled,
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
        kvEnabled,
        siteUuid,
        siteGeneration,
        updatedAt: now,
        token: userToken,
      },
    });
    metadataWritten = true;
    const confirmResult = await confirmHostnameClaim(env, claim);
    if (!confirmResult.ok && env.HOSTNAME_CLAIMS_MODE === 'enforce') {
      throw new Error(confirmResult.code || 'HOSTNAME_CLAIM_CONFIRM_FAILED');
    }
  } catch (error) {
    if (!existing && !metadataWritten) await releaseHostnameClaim(env, { ...claim, releaseReason: 'v1_deploy_failed' });
    throw error;
  }

  const result = {
    status: 'ok',
    name,
    url: metadata.url,
    devUrl: metadata.devUrl,
    fileCount: fileEntries.length,
    preset,
    ipRestrict,
  };
  const warnings = [];
  if (ipRestrict && preset === 'worker') {
    warnings.push(
      'worker preset 已注入 env.IP_ALLOWLIST，但不会改写 _worker.js。' +
        '请在 _worker.js 中调用 GET /openapi.json 中 x-libs.ip-guard 的 checkIP(request, env)。'
    );
  }
  if (warnings.length) result.warning = warnings.join(' ');
  return jsonResponse(result);
}

async function acquireHostnameClaim(env, input) {
  return writeHostnameClaim(env, 'acquire', input);
}

async function confirmHostnameClaim(env, input) {
  return writeHostnameClaim(env, 'confirm', input);
}

async function releaseHostnameClaim(env, input) {
  return writeHostnameClaim(env, 'release', input);
}

async function writeHostnameClaim(env, operation, input) {
  const mode = env.HOSTNAME_CLAIMS_MODE || 'off';
  if (mode === 'off' || !env.HOSTNAME_CLAIMS) return { ok: true };

  try {
    const method = env.HOSTNAME_CLAIMS[operation];
    const result =
      typeof method === 'function'
        ? await method.call(env.HOSTNAME_CLAIMS, input)
        : await writeHostnameClaimViaServiceBinding(env.HOSTNAME_CLAIMS, operation, input);
    if (result?.ok === false && mode === 'enforce') return result;
    return { ok: true, recorded: result || null };
  } catch (error) {
    if (mode === 'enforce') {
      return {
        ok: false,
        code: 'HOSTNAME_CLAIM_FAILED',
        message: error instanceof Error ? error.message : 'Hostname claim write failed',
      };
    }
    return { ok: true, recorded: { ok: false, code: 'HOSTNAME_CLAIM_RECORD_FAILED' } };
  }
}

async function writeHostnameClaimViaServiceBinding(binding, operation, input) {
  const response = await binding.fetch(
    new Request(`https://pages-api.internal/.xd-pages/internal/hostname-claims/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: input }),
    })
  );
  if (response.ok) return { ok: true, response: await response.json().catch(() => null) };
  const body = await response.json().catch(() => null);
  return {
    ok: false,
    code: body?.error?.code || 'HOSTNAME_CLAIM_FAILED',
    message: body?.error?.message || 'Hostname claim failed',
  };
}

function readPublicEnvironment(env) {
  return env.PUBLIC_ENVIRONMENT === 'staging' ? 'staging' : 'production';
}
