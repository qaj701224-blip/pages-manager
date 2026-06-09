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
