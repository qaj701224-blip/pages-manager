const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

export async function assertSafeWebhookUrl(value, { resolveHost } = {}) {
  const url = parseUrl(value);
  if (url.protocol !== 'https:') throw new Error('WEBHOOK_URL_PROTOCOL_INVALID');

  const hostname = normalizeHostname(url.hostname);
  if (isForbiddenHostname(hostname) || isForbiddenAddress(hostname)) {
    throw new Error('WEBHOOK_URL_HOST_FORBIDDEN');
  }

  if (isIpAddress(hostname)) return url;

  if (typeof resolveHost !== 'function') throw new Error('WEBHOOK_URL_RESOLUTION_REQUIRED');
  const resolvedAddresses = await resolveHost(hostname);
  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
    throw new Error('WEBHOOK_URL_RESOLUTION_FAILED');
  }
  for (const address of resolvedAddresses) {
    if (isForbiddenAddress(normalizeHostname(address))) throw new Error('WEBHOOK_URL_HOST_FORBIDDEN');
  }

  return url;
}

export async function dispatchWebhook({ url, eventType, deliveryId, payload, fetchImpl = fetch, resolveHost, now } = {}) {
  const safeUrl = await assertSafeWebhookUrl(url, { resolveHost });
  const timestamp = readTimestamp(now);
  const response = await fetchImpl(
    new Request(safeUrl.toString(), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'X-XD-Cell-Event': eventType,
        'X-XD-Cell-Delivery': deliveryId,
        'X-XD-Cell-Timestamp': timestamp,
      },
      body: JSON.stringify(payload),
    })
  );

  if (response.status >= 300 && response.status < 400) {
    return {
      deliveryStatus: 'failed',
      httpStatus: response.status,
      errorCode: 'WEBHOOK_REDIRECT_FORBIDDEN',
    };
  }

  return {
    deliveryStatus: response.status >= 200 && response.status < 300 ? 'succeeded' : 'failed',
    httpStatus: response.status,
    errorCode: response.status >= 200 && response.status < 300 ? null : 'WEBHOOK_HTTP_FAILED',
  };
}

export function nextRetryAt(attemptCount, now = new Date()) {
  const delay = RETRY_DELAYS_MS[Number(attemptCount || 0)];
  if (!delay) return null;
  const base = now instanceof Date ? now : new Date(now);
  return new Date(base.getTime() + delay).toISOString();
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('WEBHOOK_URL_INVALID');
  try {
    return new URL(value.trim());
  } catch {
    throw new Error('WEBHOOK_URL_INVALID');
  }
}

function readTimestamp(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split('%', 1)[0];
}

function isForbiddenHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata' ||
    hostname === '169.254.169.254'
  );
}

function isForbiddenAddress(value) {
  const address = normalizeHostname(value);
  if (isIpv4MappedIpv6(address)) return true;
  const compatibleIpv4 = readIpv4CompatibleFromIpv6(address);
  if (compatibleIpv4) return isForbiddenIpv4(compatibleIpv4);
  const mappedIpv4 = readIpv4MappedFromIpv6(address);
  if (mappedIpv4) return isForbiddenIpv4(mappedIpv4);
  if (isIpv4(address)) return isForbiddenIpv4(address);
  if (address.includes(':')) return isForbiddenIpv6(address);
  return false;
}

function isIpAddress(hostname) {
  return isIpv4(hostname) || hostname.includes(':');
}

function isIpv4(address) {
  const parts = address.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function isForbiddenIpv4(address) {
  const [first, second, third] = address.split('.').map((part) => Number(part));
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isForbiddenIpv6(address) {
  const normalized = address.replace(/^0:0:0:0:0:0:0:1$/, '::1');
  if (normalized === '::' || normalized === '::1') return true;
  const firstHextet = normalized.split(':', 1)[0];
  const first = Number.parseInt(firstHextet || '0', 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

function readIpv4MappedFromIpv6(address) {
  const match = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

function isIpv4MappedIpv6(address) {
  return /^::ffff:/i.test(address);
}

function readIpv4CompatibleFromIpv6(address) {
  const hextets = expandIpv6Hextets(address);
  if (!hextets) return null;
  if (!hextets.slice(0, 6).every((part) => part === 0)) return null;
  if (hextets[6] === 0 && hextets[7] === 0) return null;
  return ipv4FromHextets(hextets[6], hextets[7]);
}

function expandIpv6Hextets(address) {
  if (!address.includes(':')) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const dotted = normalized.slice(lastColon + 1);
    if (!isIpv4(dotted)) return null;
    const [first, second, third, fourth] = dotted.split('.').map((part) => Number(part));
    const high = ((first << 8) | second).toString(16);
    const low = ((third << 8) | fourth).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const sides = normalized.split('::');
  if (sides.length > 2) return null;
  const left = splitIpv6Side(sides[0]);
  const right = sides.length === 2 ? splitIpv6Side(sides[1]) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (sides.length === 1 && missing !== 0) return null;
  if (sides.length === 2 && missing < 1) return null;
  return [...left, ...Array(Math.max(missing, 0)).fill(0), ...right];
}

function splitIpv6Side(value) {
  if (!value) return [];
  const parts = value.split(':').map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return Number.NaN;
    return Number.parseInt(part, 16);
  });
  return parts.some((part) => Number.isNaN(part)) ? null : parts;
}

function ipv4FromHextets(high, low) {
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}
