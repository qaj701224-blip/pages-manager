import { ERROR_CODES, GATEWAY } from '../protocol.js';
import { PagesSDKError } from '../errors.js';
import type { PagesRuntimeEnv } from '../types.js';
import { DATA_SITE_CAPABILITY_HEADER, DATA_USER_CAPABILITY_HEADER, KV_CAPABILITY_HEADER } from './constants.js';

export type GatewayPaths = { get: string; set: string; delete: string };
export type DataEndpoint = { capability: string; paths: GatewayPaths };
export type DataEndpointReader = () => DataEndpoint;

const DATA_SITE_PATHS = {
  get: GATEWAY.DATA_SITE_GET_PATH,
  set: GATEWAY.DATA_SITE_SET_PATH,
  delete: GATEWAY.DATA_SITE_DELETE_PATH,
};

const DATA_USER_PATHS = {
  get: GATEWAY.DATA_USER_GET_PATH,
  set: GATEWAY.DATA_USER_SET_PATH,
  delete: GATEWAY.DATA_USER_DELETE_PATH,
};

const LEGACY_PATHS = {
  get: GATEWAY.KV_GET_PATH,
  set: GATEWAY.KV_SET_PATH,
  delete: GATEWAY.KV_DELETE_PATH,
};

export function readSiteDataEndpoint(env: PagesRuntimeEnv, request?: Request): DataEndpointReader {
  return () => {
    const requestSiteCapability = request?.headers.get(DATA_SITE_CAPABILITY_HEADER);
    if (requestSiteCapability) return { capability: requestSiteCapability, paths: DATA_SITE_PATHS };
    if (env.XD_PAGES_DATA_SITE_CAPABILITY) {
      return { capability: env.XD_PAGES_DATA_SITE_CAPABILITY, paths: DATA_SITE_PATHS };
    }
    const legacyCapability = env.XD_PAGES_KV_CAPABILITY || request?.headers.get(KV_CAPABILITY_HEADER);
    if (legacyCapability) return { capability: legacyCapability, paths: LEGACY_PATHS };
    return { capability: requireCapability(undefined, 'Site data capability is missing'), paths: DATA_SITE_PATHS };
  };
}

export function readUserDataEndpoint(request?: Request): DataEndpointReader {
  return readDataEndpoint(() => requireCapability(request?.headers.get(DATA_USER_CAPABILITY_HEADER), 'User data capability is missing'), DATA_USER_PATHS);
}

export function readLegacyKvEndpoint(env: PagesRuntimeEnv, request?: Request): DataEndpointReader {
  return readDataEndpoint(
    () => requireCapability(env.XD_PAGES_KV_CAPABILITY || request?.headers.get(KV_CAPABILITY_HEADER), 'KV capability is missing'),
    LEGACY_PATHS
  );
}

function readDataEndpoint(readCapability: () => string, paths: GatewayPaths): DataEndpointReader {
  return () => ({ capability: readCapability(), paths });
}

function requireCapability(value: string | null | undefined, message: string): string {
  if (!value) throw new PagesSDKError(ERROR_CODES.INVALID_PLATFORM_CONTEXT, message);
  return value;
}
