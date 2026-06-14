function parseMysqlUrl(value) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: url.pathname.replace(/^\/+/, '') || 'pages_manager',
  };
}

function mysqlAddr(env = {}, allowDefaults = false) {
  if (env.MYSQL_ADDR) return env.MYSQL_ADDR;
  if (env.MYSQL_HOST && env.MYSQL_PORT) return `${env.MYSQL_HOST}:${env.MYSQL_PORT}`;
  if (allowDefaults) return '127.0.0.1:3306';
  return null;
}

export function resolveMysqlConfig(env = process.env, options = {}) {
  if (env.DATABASE_URL) return parseMysqlUrl(env.DATABASE_URL);

  const addr = mysqlAddr(env, options.allowDefaults);
  if (!addr) {
    throw new Error('DATABASE_URL, MYSQL_ADDR, or MYSQL_HOST+MYSQL_PORT is required');
  }

  const [host, portValue] = addr.split(':');
  const user = env.MYSQL_USER || env.MYSQL_USERNAME || (options.allowDefaults ? 'root' : '');
  if (!user) {
    throw new Error('MYSQL_USER or MYSQL_USERNAME is required');
  }

  return {
    host,
    port: Number(portValue || 3306),
    user,
    password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'pages_manager',
  };
}

export function databaseUrlFromConfig(config) {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password || '');
  return `mysql://${user}:${password}@${config.host}:${config.port}/${config.database}`;
}

export function databaseUrlFromEnv(env = process.env, options = {}) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  return databaseUrlFromConfig(resolveMysqlConfig(env, options));
}

export function resolveRedisConfig(env = process.env) {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is required');
  }
  return {
    url: env.REDIS_URL,
  };
}
