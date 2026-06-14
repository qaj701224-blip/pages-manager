import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';

import { resolveMysqlConfig } from '../src/db/config.js';

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../drizzle/migrations');

export async function runMigrations(env = process.env) {
  const config = resolveMysqlConfig(env, { allowDefaults: true });
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    multipleStatements: true,
  });

  try {
    const db = drizzle(connection);
    await migrate(db, { migrationsFolder });
  } finally {
    await connection.end();
  }
}

export default runMigrations;

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runMigrations().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
