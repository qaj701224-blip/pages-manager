import IORedis from 'ioredis';

import { resolveRedisConfig } from './config.js';

export function createRedisClient(env = process.env, options = {}) {
  const config = resolveRedisConfig(env);
  return new IORedis(config.url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    ...options,
  });
}

export function createBullMqRedisClient(env = process.env, options = {}) {
  const config = resolveRedisConfig(env);
  return new IORedis(config.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...options,
  });
}

export async function deleteRedisKeyIfValueMatches(redis, key, value) {
  if (!redis || !key || value == null) return 0;
  return await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    1,
    key,
    value
  );
}
