import { jsonResponse } from '@xd/worker-kit';

const VALID_AUTH_ENVIRONMENTS = new Set(['production', 'staging']);

export default {
  async fetch(request, env) {
    const environment = readEnvironment(env);
    if (!environment) return errorResponse('AUTH_ENV_INVALID', 'Auth environment is invalid.', 500);

    const url = new URL(request.url);
    if (url.pathname === '/.xd-pages/health') {
      return jsonResponse(
        {
          status: 'ok',
          service: 'pages-auth',
          environment,
        },
        200,
        { 'Cache-Control': 'no-store' }
      );
    }

    return errorResponse('NOT_FOUND', 'Endpoint not found.', 404);
  },
};

export class OAuthStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

export class CliLoginDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

export class AuthSessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

function readEnvironment(env) {
  if (VALID_AUTH_ENVIRONMENTS.has(env?.PAGES_ENV)) return env.PAGES_ENV;
  return null;
}

function errorResponse(code, message, status) {
  return jsonResponse(
    {
      error: {
        code,
        message,
      },
    },
    status,
    { 'Cache-Control': 'no-store' }
  );
}
