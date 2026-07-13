import { ERROR_CODES } from '../protocol.js';
import { SDKError } from '../errors.js';
import type { EmployeeStatus, RuntimeContext, RuntimeUser } from '../types.js';
import {
  PLATFORM_AUTH_HEADER,
  PLATFORM_SITE_ID_HEADER,
  PLATFORM_SITE_SLUG_HEADER,
  PLATFORM_TRACE_ID_HEADER,
  PLATFORM_USER_HEADER,
  PLATFORM_VERSION_HEADER,
  SAFE_ID_RE,
  SITE_SLUG_RE,
  SITE_UUID_RE,
} from './constants.js';

export function readContext(request: Request): RuntimeContext | null {
  const token = request.headers.get(PLATFORM_AUTH_HEADER);
  if (!token) return null;

  const payload = decodePlatformJwtPayload(token);
  const context = platformContextFromPayload(payload);
  requireHeaderValue(request.headers, PLATFORM_USER_HEADER, context.anonymous ? 'anonymous' : context.userId);
  requireHeaderValue(request.headers, PLATFORM_SITE_ID_HEADER, context.siteId);
  requireHeaderValue(request.headers, PLATFORM_SITE_SLUG_HEADER, context.siteSlug);
  requireHeaderValue(request.headers, PLATFORM_VERSION_HEADER, context.versionId);
  requireHeaderValue(request.headers, PLATFORM_TRACE_ID_HEADER, context.traceId);
  return context;
}

export function getCurrentUser(request: Request): RuntimeUser | null {
  return readContext(request)?.user ?? null;
}

function decodePlatformJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw invalidPlatformContext('Malformed platform token');
  }

  try {
    const payloadJson = decodeBase64Url(parts[1]);
    const payload: unknown = JSON.parse(payloadJson);
    if (!isRecord(payload)) throw new Error('payload is not an object');
    return payload;
  } catch {
    throw invalidPlatformContext('Malformed platform token payload');
  }
}

function platformContextFromPayload(payload: Record<string, unknown>): RuntimeContext {
  if (payload.purpose !== 'internal_worker_jwt') throw invalidPlatformContext('Platform token purpose is invalid');

  const anonymous = readBooleanClaim(payload, 'anonymous');
  const subject = readSafeStringClaim(payload, 'sub');
  if (anonymous && subject !== 'anonymous') throw invalidPlatformContext('Anonymous platform subject is invalid');
  const user = runtimeUserFromPayload(payload, anonymous, subject);

  return {
    authenticated: !anonymous,
    anonymous,
    userId: anonymous ? null : subject,
    user,
    siteId: readSafeStringClaim(payload, 'siteId'),
    siteUuid: readSiteUuidClaim(payload, 'siteUuid'),
    siteSlug: readSiteSlugClaim(payload, 'slug'),
    routeId: readSafeStringClaim(payload, 'routeId'),
    versionId: readSafeStringClaim(payload, 'versionId'),
    policyVersion: readPositiveIntegerClaim(payload, 'policyVersion'),
    traceId: readSafeStringClaim(payload, 'traceId'),
    environment: readSafeStringClaim(payload, 'env'),
  };
}

function runtimeUserFromPayload(payload: Record<string, unknown>, anonymous: boolean, subject: string): RuntimeUser | null {
  const value = payload.user;
  if (anonymous) {
    if (value !== undefined && value !== null) throw invalidPlatformContext('Anonymous platform user is invalid');
    return null;
  }
  if (value === undefined) {
    return {
      id: subject,
      email: null,
      accountId: null,
      name: null,
      departments: [],
      employeeStatus: 'unknown',
    };
  }
  if (!isRecord(value)) throw invalidPlatformContext('Platform user is invalid');

  const id = readSafeStringClaim(value, 'id');
  if (id !== subject) throw invalidPlatformContext('Platform user does not match token subject');
  return {
    id,
    email: readOptionalTextClaim(value, 'email', 320),
    accountId: readOptionalTextClaim(value, 'accountId', 256),
    name: readOptionalTextClaim(value, 'name', 256),
    departments: readStringArrayClaim(value, 'departments'),
    employeeStatus: readEmployeeStatusClaim(value, 'employeeStatus'),
  };
}

function requireHeaderValue(headers: Headers, name: string, expected: string | null): void {
  if (expected === null || headers.get(name) !== expected) {
    throw invalidPlatformContext(`Platform header ${name} does not match token claims`);
  }
}

function readSafeStringClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value;
}

function readSiteSlugClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !SITE_SLUG_RE.test(value)) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value;
}

function readSiteUuidClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !SITE_UUID_RE.test(value)) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value;
}

function readBooleanClaim(payload: Record<string, unknown>, name: string): boolean {
  const value = payload[name];
  if (typeof value !== 'boolean') throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  return value;
}

function readPositiveIntegerClaim(payload: Record<string, unknown>, name: string): number {
  const value = payload[name];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw invalidPlatformContext(`Platform claim ${name} is invalid`);
  }
  return value as number;
}

function readOptionalTextClaim(payload: Record<string, unknown>, name: string, maxLength: number): string | null {
  const value = payload[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function readStringArrayClaim(payload: Record<string, unknown>, name: string): string[] {
  const value = payload[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\u0000-\u001f\u007f]/.test(item)
    )
    .slice(0, 64);
}

function readEmployeeStatusClaim(payload: Record<string, unknown>, name: string): EmployeeStatus {
  const value = payload[name];
  if (value === undefined) return 'unknown';
  if (value === 'active' || value === 'disabled' || value === 'left' || value === 'unknown') return value;
  return 'unknown';
}

function decodeBase64Url(value: string): string {
  if (/[^A-Za-z0-9_-]/.test(value)) throw new Error('Invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function invalidPlatformContext(message: string): SDKError {
  return new SDKError(ERROR_CODES.INVALID_PLATFORM_CONTEXT, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
