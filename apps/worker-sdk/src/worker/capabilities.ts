import { ERROR_CODES, GATEWAY } from '../protocol.js';
import { SDKError } from '../errors.js';
import type { RuntimeEnv } from '../types.js';
import { DATA_SITE_CAPABILITY_HEADER, KV_CAPABILITY_HEADER } from './constants.js';

export type GatewayPaths = { get: string; set: string; delete: string };
export type DataEndpoint = { capability: string; paths: GatewayPaths };
export type DataEndpointReader = () => DataEndpoint;

const DATA_SITE_PATHS = {
  get: GATEWAY.DATA_SITE_GET_PATH,
  set: GATEWAY.DATA_SITE_SET_PATH,
  delete: GATEWAY.DATA_SITE_DELETE_PATH,
};

const LEGACY_PATHS = {
  get: GATEWAY.KV_GET_PATH,
  set: GATEWAY.KV_SET_PATH,
  delete: GATEWAY.KV_DELETE_PATH,
};

const SITE_DATA_CAPABILITY_BINDINGS = ['XD_CELL_DATA_SITE_CAPABILITY', 'XD_PAGES_DATA_SITE_CAPABILITY'] as const;
const LEGACY_KV_CAPABILITY_BINDINGS = ['XD_CELL_KV_CAPABILITY', 'XD_PAGES_KV_CAPABILITY'] as const;

export function readSiteDataEndpoint(env: RuntimeEnv, request?: Request): DataEndpointReader {
  return () => {
    const requestSiteCapability = request?.headers.get(DATA_SITE_CAPABILITY_HEADER);
    if (requestSiteCapability) return { capability: requestSiteCapability, paths: DATA_SITE_PATHS };
    const siteCapability = readStringBinding(env, SITE_DATA_CAPABILITY_BINDINGS);
    if (siteCapability) {
      return { capability: siteCapability, paths: DATA_SITE_PATHS };
    }
    const legacyCapability = readStringBinding(env, LEGACY_KV_CAPABILITY_BINDINGS) || request?.headers.get(KV_CAPABILITY_HEADER);
    if (legacyCapability) return { capability: legacyCapability, paths: LEGACY_PATHS };
    return { capability: requireCapability(undefined, 'Site data capability is missing'), paths: DATA_SITE_PATHS };
  };
}

function requireCapability(value: string | null | undefined, message: string): string {
  if (!value) throw new SDKError(ERROR_CODES.INVALID_PLATFORM_CONTEXT, message);
  return value;
}

function readStringBinding(env: RuntimeEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
