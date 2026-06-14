import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

import { resolveMysqlConfig } from './config.js';
import * as schema from './schema.js';

let sharedPool = null;
let sharedDb = null;

export function createMysqlPool(env = process.env) {
  const config = resolveMysqlConfig(env);
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT || 10),
    maxIdle: Number(env.MYSQL_MAX_IDLE || 10),
    idleTimeout: Number(env.MYSQL_IDLE_TIMEOUT_MS || 60_000),
  });
}

export function createDb(pool) {
  return drizzle({
    client: pool,
    schema,
    mode: 'default',
  });
}

export function getDb(env = process.env) {
  if (!sharedPool) {
    sharedPool = createMysqlPool(env);
    sharedDb = createDb(sharedPool);
  }
  return sharedDb;
}

export async function closeDb() {
  if (sharedPool) {
    await sharedPool.end();
  }
  sharedPool = null;
  sharedDb = null;
}
