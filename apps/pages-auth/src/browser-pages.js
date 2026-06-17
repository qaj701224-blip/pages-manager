export function wantsHtml(request) {
  const accept = request.headers.get('Accept') || '';
  if (!accept) return false;
  if (accept.includes('application/json') && !accept.includes('text/html')) return false;
  return accept.includes('text/html');
}

export function browserPageResponse(
  {
    title,
    message,
    detail = '',
    status = 200,
    actionHref = '',
    actionLabel = '重新尝试',
    tone = 'default',
  },
  headers = {}
) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = escapeHtml(detail);
  const safeActionHref = actionHref ? escapeAttribute(actionHref) : '';
  const safeActionLabel = escapeHtml(actionLabel);
  const toneClass = tone === 'danger' ? 'is-danger' : tone === 'success' ? 'is-success' : 'is-default';
  const actionHtml = safeActionHref
    ? `<a class="button" href="${safeActionHref}" rel="noreferrer">${safeActionLabel}</a>`
    : '';

  return new Response(
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${safeTitle} - XD Pages</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #5f6f89;
      --line: #d8e0ea;
      --accent: #1f6feb;
      --danger: #c93c37;
      --success: #1f7a4d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(460px, 100%);
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 18px 50px rgba(31, 49, 77, 0.10);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .mark {
      width: 26px;
      height: 26px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      color: #fff;
      background: var(--accent);
      font-size: 14px;
      line-height: 1;
    }
    h1 {
      margin: 22px 0 10px;
      font-size: 24px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.65;
    }
    .detail {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 8px;
      background: #f3f6fa;
      color: #46566f;
      font-size: 13px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      margin-top: 22px;
      padding: 0 15px;
      border-radius: 7px;
      color: #fff;
      background: var(--accent);
      text-decoration: none;
      font-size: 14px;
      font-weight: 650;
    }
    .is-danger .mark, .is-danger .button { background: var(--danger); }
    .is-success .mark, .is-success .button { background: var(--success); }
  </style>
</head>
<body>
  <main class="${toneClass}">
    <div class="brand"><span class="mark">XD</span><span>XD Pages</span></div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${safeDetail ? `<div class="detail">${safeDetail}</div>` : ''}
    ${actionHtml}
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        ...headers,
      },
    }
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
