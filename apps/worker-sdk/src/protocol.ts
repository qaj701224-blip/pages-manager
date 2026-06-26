export const GATEWAY = {
  KV_GET_PATH: '/v1/kv/get',
  KV_GET_WITH_METADATA_PATH: '/v1/kv/get-with-metadata',
  KV_LIST_PATH: '/v1/kv/list',
  KV_SET_PATH: '/v1/kv/set',
  KV_DELETE_PATH: '/v1/kv/delete',
  DATA_SITE_GET_PATH: '/v1/data/site/get',
  DATA_SITE_GET_WITH_METADATA_PATH: '/v1/data/site/get-with-metadata',
  DATA_SITE_LIST_PATH: '/v1/data/site/list',
  DATA_SITE_SET_PATH: '/v1/data/site/set',
  DATA_SITE_DELETE_PATH: '/v1/data/site/delete',
  DATA_USER_GET_PATH: '/v1/data/user/get',
  DATA_USER_SET_PATH: '/v1/data/user/set',
  DATA_USER_DELETE_PATH: '/v1/data/user/delete',
};

export const ERROR_CODES = {
  KV_FAILED: 'KV_FAILED',
  INVALID_PLATFORM_CONTEXT: 'INVALID_PLATFORM_CONTEXT',
  INVALID_RUNTIME_RESPONSE: 'INVALID_RUNTIME_RESPONSE',
};
