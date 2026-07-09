#!/usr/bin/env node
// 临时诊断脚本 — 复现「WFP user worker 带 vpc_network binding 上传」时 Cloudflare 的真实行为。
//
// 背景:自定义 Worker 站点(worker-only / worker-with-assets)经 pages-api 上传到 WFP dispatch
// namespace 时,会被无条件注入 XD_OFFICE_NET 的 vpc_network binding(见 apps/pages-api/src/wfp-provider.js
// 的 userWorkerVpcNetworkBindings)。近期这类站点部署稳定返回 DEPLOYMENT_UPLOAD_FAILED,但真实的
// Cloudflare 错误在 pages-api 的 upload catch 里被转成兜底码后丢弃了。此脚本用同一套 wfp-client 直接对
// dispatch namespace 做「带 / 不带 vpc binding」的对照上传,把 Cloudflare 的原始(已脱敏)响应打印出来,
// 用来区分两种根因:CF_API_TOKEN 缺 Connectivity Directory 权限,还是 binding metadata 格式问题。
//
// 安全约束:
//   - 默认只操作 staging dispatch namespace;对 production namespace 必须显式传 --allow-production
//     (或环境变量 ALLOW_PRODUCTION=true)才放行,防止误触。
//   - 临时脚本名带 vpc-probe- 前缀 + 时间戳,每次探测跑完立即 DELETE;探测 worker 无路由指向,不影响任何真实站点。
//   - token 从环境变量读取,不落盘、不打印;Cloudflare 错误消息由 wfp-client 的 redactCloudflareError 统一脱敏。
//
// 用法:
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... PAGES_USER_WORKER_VPC_TUNNEL_ID=... \
//     node scripts/probe-wfp-vpc-binding.mjs [dispatch-namespace] [--allow-production]
//   dispatch-namespace 默认 xd-cell-workers-staging。

import { createWfpClient } from '../packages/wfp-client/src/index.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`::error::missing required env ${name}`);
    process.exit(2);
  }
  return value.trim();
}

const args = process.argv.slice(2);
const allowProduction = args.includes('--allow-production') || process.env.ALLOW_PRODUCTION === 'true';
const positional = args.filter((arg) => !arg.startsWith('--'));

const apiToken = requireEnv('CF_API_TOKEN');
const accountId = requireEnv('CF_ACCOUNT_ID');
const tunnelId = requireEnv('PAGES_USER_WORKER_VPC_TUNNEL_ID');
const dispatchNamespace = (positional[0] || 'xd-cell-workers-staging').trim();

if (dispatchNamespace.includes('production') && !allowProduction) {
  console.error('::error::refusing to probe a production dispatch namespace without --allow-production');
  process.exit(2);
}

const client = createWfpClient({
  accountId,
  apiToken,
  dispatchNamespace,
  apiBaseUrl: 'https://api.cloudflare.com/client/v4',
  fetch: globalThis.fetch,
});

const stamp = Date.now().toString(36);
const WORKER_MODULE = "export default { async fetch() { return new Response('vpc-probe'); } };";

async function probe(label, bindings) {
  const scriptName = `vpc-probe-${label}-${stamp}`;
  console.log(`\n=== [${label}] PUT ${scriptName} (${bindings.length} binding) ===`);
  let outcome = { label, ok: false };
  try {
    await client.uploadUserWorker({
      scriptName,
      mainModule: 'index.js',
      modules: [{ name: 'index.js', content: WORKER_MODULE, type: 'application/javascript+module' }],
      decision: { deploymentShape: 'worker-only' },
      compatibilityDate: '2026-06-15',
      tags: ['vpc-probe'],
      bindings,
    });
    console.log(`[${label}] SUCCESS`);
    outcome = { label, ok: true };
  } catch (error) {
    console.log(`[${label}] FAILED status=${error?.status ?? 'n/a'} code=${error?.code ?? 'n/a'}`);
    console.log(`[${label}] cloudflare says: ${error?.message ?? String(error)}`);
    outcome = { label, ok: false, status: error?.status, message: error?.message };
  } finally {
    try {
      await client.deleteUserWorker(scriptName);
      console.log(`[${label}] cleaned up ${scriptName}`);
    } catch (error) {
      console.log(`[${label}] cleanup skipped (${error?.status ?? error?.message ?? 'error'})`);
    }
  }
  return outcome;
}

console.log(`probing namespace: ${dispatchNamespace}${allowProduction ? ' (production allowed)' : ''}`);

// 对照组:baseline 不带任何 binding,确认这个 token 能正常上传普通 user worker;
// 实验组:只加 XD_OFFICE_NET 的 vpc_network binding,和 wfp-provider 生产路径构造一致。
const baseline = await probe('baseline', []);
const vpc = await probe('vpc', [{ type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: tunnelId }]);

console.log('\n=== SUMMARY ===');
console.log(`namespace           : ${dispatchNamespace}`);
console.log(`baseline (0 binding): ${baseline.ok ? 'OK' : `FAILED (${baseline.status ?? 'n/a'})`}`);
console.log(`vpc_network binding : ${vpc.ok ? 'OK' : `FAILED (${vpc.status ?? 'n/a'})`}`);

if (baseline.ok && !vpc.ok) {
  console.log(
    '\n结论:基础 worker 能上传,加 vpc_network binding 被 CF 拒 → 坐实 vpc binding 是 DEPLOYMENT_UPLOAD_FAILED 的根因。'
  );
  console.log('依据上面 [vpc] cloudflare says 判断修法:');
  console.log(
    '  - 含 authorization / permission / not authorized / 10000 → CF_API_TOKEN 缺 Connectivity Directory 权限,补权限即可,不改代码、不删 tunnel var。'
  );
  console.log(
    '  - 含 binding / tunnel / invalid / unknown → binding metadata 格式问题,需改 wfp-provider/wfp-client 的 vpc binding 构造。'
  );
} else if (!baseline.ok) {
  console.log(
    '\n结论:连 0 binding 的基础上传都失败,说明是更底层的 token / namespace / 账户问题,不止 vpc binding,先看 [baseline] cloudflare says。'
  );
} else {
  console.log('\n结论:该 namespace 下带 vpc_network binding 也能成功,说明这套 token 的权限没问题。');
}
