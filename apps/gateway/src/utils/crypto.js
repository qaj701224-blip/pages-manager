const textEncoder = new globalThis.TextEncoder();

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualString(a, b) {
  const left = textEncoder.encode(String(a ?? ''));
  const right = textEncoder.encode(String(b ?? ''));

  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}
