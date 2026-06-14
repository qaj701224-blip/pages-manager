import mysql from 'mysql2/promise';

import { resolveMysqlConfig } from '../src/db/config.js';
import { runMigrations } from './migrate.js';

const shouldReset = process.argv.includes('--reset');

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll('`', '``')}\``;
}

async function ensureDatabase(config) {
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: false,
  });

  try {
    if (shouldReset) {
      await connection.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(config.database)}`);
    }
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await connection.end();
  }
}

async function main() {
  const config = resolveMysqlConfig(process.env, { allowDefaults: true });
  await ensureDatabase(config);
  await runMigrations(process.env);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
