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
    statusLabel = '',
    tone = 'default',
  },
  headers = {}
) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = escapeHtml(detail);
  const safeActionHref = safeHttpHref(actionHref);
  const safeActionLabel = escapeHtml(actionLabel);
  const safeStatusLabel = escapeHtml(statusLabel || defaultStatusLabel(tone));
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
  <title>${safeTitle} - XD Cell</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff7ef;
      --panel: #fffdf9;
      --text: #261711;
      --muted: #735a49;
      --line: #ead8c8;
      --accent: #f59e0b;
      --brand: #f37022;
      --danger: #d64545;
      --success: #d88712;
      --success-soft: #f7b733;
      --shadow: 0 24px 70px rgba(95, 52, 25, 0.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 18px;
      background:
        radial-gradient(circle at 18% 12%, rgba(243, 112, 34, 0.16), transparent 30%),
        radial-gradient(circle at 82% 8%, rgba(245, 158, 11, 0.1), transparent 28%),
        linear-gradient(135deg, #fff8f1 0%, #fffdf9 48%, #fff3e7 100%);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(520px, 100%);
      border: 1px solid rgba(231, 198, 173, 0.92);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .content {
      padding: 28px 30px 30px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 26px 30px 22px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(135deg, rgba(243, 112, 34, 0.12), rgba(245, 158, 11, 0.09)),
        var(--panel);
      color: #3a2a22;
      font-size: 13px;
      font-weight: 700;
    }
    .mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      color: #fff;
      background: linear-gradient(135deg, var(--brand), var(--accent));
      box-shadow: 0 10px 24px rgba(243, 112, 34, 0.24);
      font-size: 13px;
      line-height: 1;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 27px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      margin: 0 0 16px;
      padding: 0 11px;
      border: 1px solid rgba(231, 198, 173, 0.9);
      border-radius: 999px;
      background: #fff7ed;
      color: #8a3c12;
      font-size: 12px;
      font-weight: 750;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.65;
    }
    .detail {
      margin-top: 18px;
      padding: 13px 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fffaf6;
      color: #634b3b;
      font-size: 13px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      margin-top: 22px;
      padding: 0 17px;
      border-radius: 11px;
      color: #fff;
      background: linear-gradient(135deg, var(--brand), var(--accent));
      text-decoration: none;
      font-size: 14px;
      font-weight: 750;
      box-shadow: 0 14px 34px rgba(243, 112, 34, 0.23);
    }
    .is-danger .mark, .is-danger .button { background: linear-gradient(135deg, #f05f57, var(--danger)); }
    .is-success .mark, .is-success .button { background: linear-gradient(135deg, var(--brand), var(--success-soft)); }
    .is-success .status-pill {
      border-color: rgba(245, 158, 11, 0.35);
      background: #fff8e8;
      color: #7a4a05;
    }
    @media (max-width: 520px) {
      body { padding: 18px 12px; }
      main { border-radius: 14px; }
      .brand, .content { padding-left: 20px; padding-right: 20px; }
      h1 { font-size: 23px; }
    }
  </style>
</head>
<body>
  <main class="${toneClass}">
    <div class="brand"><span class="mark">XD</span><span>XD Cell</span></div>
    <div class="content">
      <div class="status-pill">状态：${safeStatusLabel}</div>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      ${safeDetail ? `<div class="detail">${safeDetail}</div>` : ''}
      ${actionHtml}
    </div>
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

function safeHttpHref(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  return escapeAttribute(url.toString());
}

function defaultStatusLabel(tone) {
  if (tone === 'success') return '已完成';
  if (tone === 'danger') return '需要处理';
  return '请留意';
}
