import assert from 'node:assert/strict';
import test from 'node:test';

import { ENV_GUARD_SOURCE, buildBakedGuardSource, isAllowedIP, parseAllowlist } from './index.js';

function requestWithIP(ip) {
  return new Request('https://example.com', {
    headers: ip ? { 'CF-Connecting-IP': ip } : {},
  });
}

test('parseAllowlist handles comma whitespace newline separators and removes empty entries', () => {
  assert.deepEqual(parseAllowlist(' 127.0.0.1, 10.0.0.0/8\n\n::1\t, '), ['127.0.0.1', '10.0.0.0/8', '::1']);
});

test('isAllowedIP allows and denies exact IPv4 entries', () => {
  assert.equal(isAllowedIP('127.0.0.1', '127.0.0.1'), true);
  assert.equal(isAllowedIP('127.0.0.2', '127.0.0.1'), false);
});

test('isAllowedIP allows and denies IPv4 CIDR entries', () => {
  assert.equal(isAllowedIP('10.2.3.4', '10.0.0.0/8'), true);
  assert.equal(isAllowedIP('11.2.3.4', '10.0.0.0/8'), false);
});

test('isAllowedIP handles CIDR boundaries /0 and /32', () => {
  assert.equal(isAllowedIP('203.0.113.9', '0.0.0.0/0'), true);
  assert.equal(isAllowedIP('192.0.2.10', '192.0.2.10/32'), true);
  assert.equal(isAllowedIP('192.0.2.11', '192.0.2.10/32'), false);
});

test('isAllowedIP allows and denies exact IPv6 entries', () => {
  assert.equal(isAllowedIP('::1', '127.0.0.1,::1'), true);
  assert.equal(isAllowedIP('2001:db8::1', '127.0.0.1,::1'), false);
});

test('isAllowedIP denies missing IP, empty allowlist, invalid IPv4, and ignores invalid CIDR', () => {
  assert.equal(isAllowedIP('', '127.0.0.1'), false);
  assert.equal(isAllowedIP('127.0.0.1', ''), false);
  assert.equal(isAllowedIP('999.0.0.1', '999.0.0.1'), false);
  assert.equal(isAllowedIP('10.0.0.1', 'bad/99,10.0.0.2'), false);
  assert.equal(isAllowedIP('10.0.0.1', 'bad/99,10.0.0.0/8'), true);
});

test('buildBakedGuardSource checks IP without env binding', () => {
  const source = buildBakedGuardSource('127.0.0.1, ::1');

  assert.match(source, /const A=\["127\.0\.0\.1","::1"\]/);
  assert.match(source, /function checkIP\(req\)/);
  assert.doesNotMatch(source, /env\.IP_ALLOWLIST/);
});

test('buildBakedGuardSource checkIP allows and blocks without env binding', () => {
  const checkIP = new Function(`${buildBakedGuardSource('127.0.0.1,10.0.0.0/8,::1')}; return checkIP;`)();

  assert.equal(checkIP(requestWithIP('127.0.0.1')), null);
  assert.equal(checkIP(requestWithIP('10.1.2.3')), null);
  assert.equal(checkIP(requestWithIP('::1')), null);
  assert.equal(checkIP(requestWithIP('198.51.100.10')).status, 403);
});

test('ENV_GUARD_SOURCE reads env.IP_ALLOWLIST and exposes checkIP(request, env)', () => {
  assert.match(ENV_GUARD_SOURCE, /env\.IP_ALLOWLIST/);
  assert.match(ENV_GUARD_SOURCE, /function checkIP\(request, env\)/);
});

test('ENV_GUARD_SOURCE checkIP allows and blocks using env.IP_ALLOWLIST', () => {
  const checkIP = new Function(`${ENV_GUARD_SOURCE}; return checkIP;`)();
  const env = { IP_ALLOWLIST: '127.0.0.1,::1' };

  assert.equal(checkIP(requestWithIP('127.0.0.1'), env), null);
  assert.equal(checkIP(requestWithIP('::1'), env), null);
  assert.equal(checkIP(requestWithIP('127.0.0.2'), env).status, 403);
});
