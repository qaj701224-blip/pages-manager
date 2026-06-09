import { parseAllowlist } from './ip.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

const MIME_WORKER_HELPER = `
const M={html:"text/html",htm:"text/html",css:"text/css",js:"application/javascript",
mjs:"application/javascript",json:"application/json",xml:"application/xml",
txt:"text/plain",svg:"image/svg+xml",png:"image/png",jpg:"image/jpeg",
jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",ico:"image/x-icon",
woff:"font/woff",woff2:"font/woff2",ttf:"font/ttf",otf:"font/otf",
mp4:"video/mp4",webm:"video/webm",pdf:"application/pdf",wasm:"application/wasm",
map:"application/json"};
function mime(p){
const s=p.split("/").pop();if(!s||!s.includes("."))return"text/html";
const e=s.split(".").pop();return M[e]||"application/octet-stream"}
function typed(req,res){if(!res.ok)return res;
const u=new URL(req.url);let p=u.pathname;if(p.endsWith("/"))p+="index.html";
const ct=mime(p);const h=new Headers(res.headers);h.set("content-type",
ct.startsWith("text/")?ct+"; charset=utf-8":ct);
return new Response(res.body,{status:res.status,headers:h})}`;

function buildIpGuard(allowlist) {
  const entries = JSON.stringify(parseAllowlist(allowlist));
  return `
const A=${entries};
function n2i(ip){return ip.split(".").reduce((a,o)=>(a<<8)+Number(o),0)>>>0}
const R=A.map(e=>{if(e.includes(":"))return{t:6,v:e};
if(e.includes("/")){const[b,s]=e.split("/");const m=~((1<<(32-Number(s)))-1)>>>0;return{t:4,n:n2i(b)&m,m};}
return{t:4,v:n2i(e)};});
function checkIP(req){const ip=req.headers.get("CF-Connecting-IP");if(!ip)return null;
if(ip.includes(":"))return R.some(r=>r.t===6&&r.v===ip)?null:new Response("IP not allowed",{status:403});
const n=n2i(ip);const ok=R.some(r=>{if(r.t===6)return false;if(r.v!==undefined)return r.v===n;return(n&r.m)===r.n;});
return ok?null:new Response("IP not allowed",{status:403});}`;
}

const STATIC_WORKER = `${MIME_WORKER_HELPER}
export default {
  async fetch(request, env) {
    return typed(request, await env.ASSETS.fetch(request));
  },
}`;

function buildStaticWorkerIp(allowlist) {
  return `${MIME_WORKER_HELPER}
${buildIpGuard(allowlist)}
export default {
  async fetch(request, env) {
    const b=checkIP(request);if(b)return b;
    return typed(request, await env.ASSETS.fetch(request));
  },
}`;
}

const SPA_WORKER = `${MIME_WORKER_HELPER}
export default {
  async fetch(request, env) {
    return typed(request, await env.ASSETS.fetch(request));
  },
}`;

function buildSpaWorkerIp(allowlist) {
  return `${MIME_WORKER_HELPER}
${buildIpGuard(allowlist)}
export default {
  async fetch(request, env) {
    const b=checkIP(request);if(b)return b;
    return typed(request, await env.ASSETS.fetch(request));
  },
}`;
}

const WORKER_SCRIPTS = { static: STATIC_WORKER, spa: SPA_WORKER };

const PRESET_CONFIG = {
  static: { not_found_handling: '404-page', run_worker_first: true },
  spa: { not_found_handling: 'single-page-application', run_worker_first: true },
  worker: { not_found_handling: '404-page', run_worker_first: true },
};

async function cfFetch(path, token, options = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (options.rawResponse) return res;
  const json = await res.json();
  if (!json.success) {
    const msg = json.errors?.map((e) => e.message).join('; ') || 'CF API error';
    const err = new Error(msg);
    err.status = res.status;
    err.errors = json.errors;
    throw err;
  }
  return json.result;
}

const MIME_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  zip: 'application/zip',
  map: 'application/json',
  wasm: 'application/wasm',
};

function getMimeType(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function hashFile(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32);
}

export async function buildManifest(files) {
  const manifest = {};
  const fileMap = new Map();

  for (const { path, bytes } of files) {
    const hash = await hashFile(bytes);
    const key = path.startsWith('/') ? path : `/${path}`;
    manifest[key] = { hash, size: bytes.byteLength, content_type: getMimeType(key) };
    fileMap.set(hash, { path: key, bytes });
  }

  return { manifest, fileMap };
}

export async function registerUploadSession(token, accountId, scriptName, manifest) {
  return cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });
}

export async function uploadAssetBuckets(uploadJwt, accountId, buckets, fileMap) {
  let completionJwt = null;

  for (const bucket of buckets) {
    const form = new FormData();

    for (const hash of bucket) {
      const entry = fileMap.get(hash);
      if (!entry) continue;
      const u8 = new Uint8Array(entry.bytes);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < u8.length; i += chunkSize) {
        binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
      }
      const b64 = btoa(binary);
      form.append(hash, new Blob([b64]), hash);
    }

    const res = await fetch(`${CF_API}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${uploadJwt}` },
      body: form,
    });

    const json = await res.json();
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join('; ') || 'Asset upload failed';
      throw new Error(msg);
    }
    if (json.result?.jwt) {
      completionJwt = json.result.jwt;
    }
  }

  return completionJwt;
}

export function buildWorkerMetadata(completionJwt, preset, ipRestrict, allowlist) {
  const config = PRESET_CONFIG[preset] || PRESET_CONFIG.static;
  const bindings = [{ type: 'assets', name: 'ASSETS' }];

  if (preset === 'worker' && ipRestrict) {
    bindings.push({ type: 'plain_text', name: 'IP_ALLOWLIST', text: allowlist || '' });
  }

  return {
    main_module: 'worker.js',
    compatibility_date: '2025-05-01',
    bindings,
    assets: {
      jwt: completionJwt,
      config,
    },
  };
}

export function buildWorkerCode(preset, workerCode, ipRestrict, allowlist) {
  const ipScripts = {
    static: buildStaticWorkerIp(allowlist),
    spa: buildSpaWorkerIp(allowlist),
  };
  const scripts = ipRestrict && preset !== 'worker' ? ipScripts : WORKER_SCRIPTS;
  return workerCode || scripts[preset] || WORKER_SCRIPTS.static;
}

export async function deployScript(token, accountId, scriptName, completionJwt, preset, workerCode, ipRestrict, allowlist) {
  const metadata = buildWorkerMetadata(completionJwt, preset, ipRestrict, allowlist);
  const code = buildWorkerCode(preset, workerCode, ipRestrict, allowlist);

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');

  return cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}`, token, {
    method: 'PUT',
    body: form,
  });
}

export async function enableSubdomain(token, accountId, scriptName) {
  return cfFetch(`/accounts/${accountId}/workers/services/${scriptName}/environments/production/subdomain`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
}

export async function deleteScript(token, accountId, scriptName) {
  if (!scriptName || !scriptName.startsWith('pages-')) {
    throw new Error(`安全拦截：拒绝删除非 pages- 前缀的 Worker "${scriptName}"`);
  }
  return cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}?force=true`, token, {
    method: 'DELETE',
  });
}

export async function bindRoute(token, zoneId, pattern, scriptName) {
  const routes = await cfFetch(`/zones/${zoneId}/workers/routes`, token);
  const existing = routes.find((r) => r.pattern === pattern);
  if (existing) {
    return cfFetch(`/zones/${zoneId}/workers/routes/${existing.id}`, token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, script: scriptName }),
    });
  }
  return cfFetch(`/zones/${zoneId}/workers/routes`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern, script: scriptName }),
  });
}

export async function listDomains(token, accountId) {
  return cfFetch(`/accounts/${accountId}/workers/domains`, token);
}
