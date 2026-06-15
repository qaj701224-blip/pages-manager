import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

const DEVICE_CODE_RE = /^[0-9]{8}$/;

export async function createCliLogin({
  environment,
  now,
  ttlSeconds,
  loginId = createOpaqueToken('cli'),
  loginSecret = createOpaqueToken('sec'),
  deviceCode = createDeviceCode(),
}) {
  if (environment !== 'production' && environment !== 'staging') throw new Error('CLI login environment is invalid');
  if (!DEVICE_CODE_RE.test(deviceCode)) throw new Error('CLI login device code must be 8 digits');

  return {
    loginId,
    loginSecret,
    deviceCode,
    record: {
      id: loginId,
      environment,
      deviceCode,
      secretHash: await sha256Hex(loginSecret),
      status: 'pending',
      userId: null,
      issuedAt: now,
      confirmedAt: null,
      consumedAt: null,
      expiresAt: now + ttlSeconds,
    },
  };
}

export function confirmCliLogin({ deviceCode, userId }, record, { now }) {
  assertUsableRecord(record, now);
  if (record.status !== 'pending') throw new Error(`CLI login invalid: status is ${record.status}`);
  if (record.deviceCode !== deviceCode) throw new Error('CLI login invalid: device code mismatch');
  if (typeof userId !== 'string' || userId === '') throw new Error('CLI login invalid: user id is required');

  return { ...record, status: 'confirmed', userId, confirmedAt: now };
}

export async function consumeCliLogin({ loginId, loginSecret }, record, { now }) {
  assertUsableRecord(record, now);
  if (record.id !== loginId) throw new Error('CLI login invalid: unknown login id');
  if (record.status === 'pending') throw new Error('CLI login invalid: still pending');
  if (record.status === 'consumed') throw new Error('CLI login invalid: already consumed');
  if (record.status !== 'confirmed') throw new Error(`CLI login invalid: status is ${record.status}`);

  const actualHash = await sha256Hex(loginSecret);
  if (!constantTimeEqualHex(record.secretHash, actualHash)) throw new Error('CLI login invalid: secret mismatch');

  const consumedRecord = { ...record, status: 'consumed', consumedAt: now };
  return { userId: record.userId, environment: record.environment, record: consumedRecord };
}

function assertUsableRecord(record, now) {
  if (!record || typeof record !== 'object') throw new Error('CLI login invalid: missing record');
  if (record.expiresAt <= now) throw new Error('CLI login invalid: expired');
}

function createDeviceCode() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 100_000_000).padStart(8, '0');
}
