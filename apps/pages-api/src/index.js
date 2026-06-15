import { readApiConfig } from './config.js';
import { jsonError, jsonOk } from './http.js';

export default {
  async fetch(request, env) {
    let config;
    try {
      config = readApiConfig(env);
    } catch {
      return jsonError(
        'API_ENV_INVALID',
        'Pages API environment is invalid.',
        500,
        'Check the pages-api Worker environment configuration.'
      );
    }

    const url = new URL(request.url);
    if (url.pathname === '/.xd-pages/health') {
      return jsonOk({
        status: 'ok',
        service: 'pages-api',
        environment: config.environment,
      });
    }

    return jsonError('NOT_FOUND', 'Endpoint not found.', 404, 'Check the endpoint path and API version.');
  },
};
