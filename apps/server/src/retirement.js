import { jsonResponse } from '@xd/worker-kit';

export const LEGACY_API_RETIRED_CODE = 'LEGACY_API_RETIRED';
export const LEGACY_API_RETIRED_MESSAGE =
  '如果你使用 Cindy 客户端，请使用 xd-sites 插件；如果无法安装或找不到插件，请先更新 Cindy 客户端。' +
  '非 Cindy 客户端请使用 https://skills.xindong.com/skills/xd-cell 的 skill。';

export function legacyApiRetiredResponse() {
  return jsonResponse(
    {
      error: LEGACY_API_RETIRED_CODE,
      message: LEGACY_API_RETIRED_MESSAGE,
    },
    410,
    { 'Cache-Control': 'no-store' }
  );
}

export function isLegacyApiRetiredRequest(request) {
  const url = new URL(request.url);
  return !(url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD'));
}

export function legacyApiRetirementResponseForRequest(request) {
  return isLegacyApiRetiredRequest(request) ? legacyApiRetiredResponse() : jsonResponse({ status: 'ok' });
}
