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
