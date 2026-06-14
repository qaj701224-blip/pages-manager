import { defineConfig } from 'drizzle-kit';

import { databaseUrlFromEnv } from './src/db/config.js';

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.js',
  out: './drizzle/migrations',
  dbCredentials: {
    url: databaseUrlFromEnv(process.env, { allowDefaults: true }),
  },
});
