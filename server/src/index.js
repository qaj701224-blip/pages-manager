import { Router } from './router.js';
import { isAllowedIP } from './lib/ip.js';
import { handleDeploy } from './handlers/deploy.js';
import { handleGetSite, handleDeleteSite } from './handlers/site.js';
import { handleList } from './handlers/list.js';
import { handleHealth } from './handlers/health.js';
import { handleOpenAPI } from './handlers/openapi.js';
import { renderSkill } from './handlers/skill.js';
import { getPublicConfig } from './lib/public-config.js';
import README from '../../README.md';
import SKILL from '../../pages-deploy.skill.md';

const router = new Router();
router.post('/deploy', handleDeploy);
router.get('/site/:name', handleGetSite);
router.delete('/site/:name', handleDeleteSite);
router.get('/list', handleList);
router.get('/health', handleHealth);
router.get('/openapi.json', handleOpenAPI);
router.get(
  '/readme.md',
  () =>
    new Response(README, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    })
);
router.get(
  '/skill.md',
  (request, env) =>
    new Response(renderSkill(SKILL, getPublicConfig(request, env)), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
    })
);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PUBLIC_PATHS = new Set(['/openapi.json', '/skill.md', '/readme.md']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP');

    if (!PUBLIC_PATHS.has(url.pathname) && !isAllowedIP(clientIP, env.IP_ALLOWLIST)) {
      return json(
        {
          error: 'IP 未授权',
          ip: clientIP,
          hint: '该 IP 不在内网白名单内。WebFetch 等工具的出口 IP 可能不在白名单，请改用 curl 命令行直接请求（curl 走用户本机网络）。',
        },
        403
      );
    }

    const match = router.match(request.method, url.pathname);

    if (!match) {
      return json(
        { error: '端点不存在', method: request.method, path: url.pathname, hint: 'GET /openapi.json 查看可用端点' },
        404
      );
    }

    try {
      return await match.handler(request, env, match.params);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message, errors: err.errors }, status);
    }
  },
};
