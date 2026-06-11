import { getPublicConfig, replacePublicText } from '../lib/public-config.js';

export function renderReadme(template, config) {
  return replacePublicText(template, config);
}

export function handleReadme(template, request, env) {
  return new Response(renderReadme(template, getPublicConfig(request, env)), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
