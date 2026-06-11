export function parseAllowlist(value = '') {
  return String(value)
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = (result << 8) + octet;
  }
  return result >>> 0;
}

function parseRule(entry) {
  if (entry.includes(':')) return { type: 'exact6', value: entry };
  if (entry.includes('/')) {
    const [base, bitsValue] = entry.split('/');
    const baseInt = ipToInt(base);
    const bits = Number(bitsValue);
    if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0;
    return { type: 'cidr', network: baseInt & mask, mask };
  }

  const exact = ipToInt(entry);
  return exact === null ? null : { type: 'exact4', value: exact };
}

export function isAllowedIP(ip, allowlist = '') {
  if (!ip) return false;

  const rules = parseAllowlist(allowlist).map(parseRule).filter(Boolean);
  if (rules.length === 0) return false;

  if (ip.includes(':')) {
    return rules.some((rule) => rule.type === 'exact6' && rule.value === ip);
  }

  const ipInt = ipToInt(ip);
  if (ipInt === null) return false;

  return rules.some((rule) => {
    if (rule.type === 'exact4') return rule.value === ipInt;
    if (rule.type === 'cidr') return (ipInt & rule.mask) === rule.network;
    return false;
  });
}

export function buildBakedGuardSource(allowlist) {
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

export const ENV_GUARD_SOURCE = [
  'function getAllowed(env) {',
  '  return String(env.IP_ALLOWLIST || "")',
  '    .split(",")',
  '    .map((entry) => entry.trim())',
  '    .filter(Boolean);',
  '}',
  '',
  'function ipToInt(ip) {',
  '  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;',
  '}',
  '',
  'function toRules(allowed) {',
  '  return allowed.map((entry) => {',
  '  if (entry.includes(":")) return { type: "exact6", value: entry };',
  '  if (entry.includes("/")) {',
  '    const [base, bits] = entry.split("/");',
  '    const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;',
  '    return { type: "cidr", network: ipToInt(base) & mask, mask };',
  '  }',
  '  return { type: "exact4", value: ipToInt(entry) };',
  '  });',
  '}',
  '',
  'function checkIP(request, env) {',
  '  const rules = toRules(getAllowed(env));',
  '  const ip = request.headers.get("CF-Connecting-IP");',
  '  if (!ip) return null;',
  '  if (ip.includes(":")) {',
  '    return rules.some((r) => r.type === "exact6" && r.value === ip)',
  '      ? null',
  '      : new Response("IP not allowed", { status: 403 });',
  '  }',
  '  const n = ipToInt(ip);',
  '  const ok = rules.some((r) => {',
  '    if (r.type === "exact4") return r.value === n;',
  '    if (r.type === "cidr") return (n & r.mask) === r.network;',
  '    return false;',
  '  });',
  '  return ok ? null : new Response("IP not allowed", { status: 403 });',
  '}',
].join('\n');
