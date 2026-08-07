import { jsonResponse } from '@xd/worker-kit';

export function wantsHtml(request) {
  const accept = request.headers.get('Accept') || '';
  if (accept.includes('application/json') && !accept.includes('text/html')) return false;
  return accept.includes('text/html');
}

export function browserPageResponse({
  title,
  message,
  detail = '',
  status = 200,
  actionHref = '',
  actionLabel = '重新尝试',
  statusLabel = '',
  tone = 'default',
}) {
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

const GENERIC_SITE_ERROR = {
  status: 500,
  message: 'Site could not be opened.',
  page: {
    title: '站点暂时无法打开',
    message: '站点暂时无法确认。请稍后再试，或联系站点管理员检查发布状态。',
    statusLabel: '暂时不可用',
  },
};

const HOST_NOT_ROUTABLE = {
  status: 404,
  message: 'Host is not a routable XD Cell site.',
  page: {
    title: '站点地址无效',
    message: '这个站点地址无效，请确认访问地址是否正确。',
    statusLabel: '地址无效',
  },
};

const ROUTE_UNCONFIRMED_PAGE = {
  title: '站点暂时无法打开',
  message: '站点路由暂时无法确认。请稍后再试，或联系站点管理员检查发布状态。',
  statusLabel: '路由异常',
};

const SITE_ERROR_REGISTRY = Object.freeze({
  INVALID_HOST: HOST_NOT_ROUTABLE,
  RESERVED_HOST: HOST_NOT_ROUTABLE,
  RESERVED_SLUG: HOST_NOT_ROUTABLE,
  INVALID_SLUG: HOST_NOT_ROUTABLE,
  HOST_ENV_MISMATCH: HOST_NOT_ROUTABLE,
  PLATFORM_PATH_RESERVED: {
    status: 404,
    message: 'This platform path is not dispatched to user workers.',
    page: {
      title: '站点暂时无法打开',
      message: '这个平台路径不会转发到用户站点。',
      statusLabel: '路径不可用',
    },
  },
  ROUTER_ENV_INVALID: {
    status: 500,
    message: 'Router environment is invalid.',
    page: {
      title: '站点暂时无法打开',
      message: '站点路由环境配置无效，请稍后再试。',
      statusLabel: '路由异常',
    },
  },
  ROUTE_NOT_FOUND: {
    status: 404,
    message: 'Site route not found.',
    page: {
      title: '站点没有找到',
      message: '这个站点还没有发布，或者路由已经被移除。请确认访问地址是否正确。',
      statusLabel: '站点不存在',
    },
  },
  ROUTE_INACTIVE: {
    status: 404,
    message: 'Site route is not active.',
    page: {
      title: '站点暂时不可访问',
      message: '这个站点当前没有可用的发布版本。请稍后再试，或联系站点管理员确认发布状态。',
      statusLabel: '站点未启用',
    },
  },
  ROUTE_SNAPSHOT_INVALID: {
    status: 503,
    message: 'Route snapshot is invalid.',
    page: ROUTE_UNCONFIRMED_PAGE,
  },
  ROUTE_ENV_MISMATCH: {
    status: 403,
    message: 'Route environment does not match router environment.',
    page: ROUTE_UNCONFIRMED_PAGE,
  },
  ROUTE_WORKER_INVALID: {
    status: 403,
    message: 'Route worker target is invalid.',
    page: ROUTE_UNCONFIRMED_PAGE,
  },
  IP_DENIED: {
    status: 403,
    message: 'Client IP is not allowed.',
    page: {
      title: '当前网络无法访问站点',
      message: '当前网络不在允许范围，请连接公司网络或 VPN 后重试。',
      statusLabel: '需要处理',
    },
  },
  DISPATCH_UNAVAILABLE: {
    status: 503,
    message: 'Route dispatch target is not available.',
    page: {
      title: '站点暂时无法打开',
      message: '站点发布版本暂时无法启动，请稍后再试。',
      statusLabel: '服务不可用',
    },
  },
  INTERNAL_JWT_CREATE_FAILED: {
    status: 500,
    message: 'Internal worker token could not be created.',
    page: {
      title: '站点暂时无法打开',
      message: '站点暂时无法启动，请稍后再试。',
      statusLabel: '服务异常',
    },
  },
  AUTH_BASE_INVALID: {
    status: 500,
    message: 'Auth base URL is invalid.',
    page: {
      title: '站点暂时无法打开',
      message: '登录服务配置无效，请稍后再试。',
      statusLabel: '服务异常',
    },
  },
  SITE_AUTH_CALLBACK_INVALID: {
    status: 400,
    message: 'Site auth callback is invalid.',
    page: {
      title: '访问验证没有完成',
      message: '这次访问验证链接无效。重新打开站点会自动再次发起验证。',
      statusLabel: '需要重新验证',
    },
  },
  SITE_AUTH_CODE_INVALID: {
    status: 400,
    message: 'Site auth code is invalid.',
    page: {
      title: '访问验证没有完成',
      message: '这次验证凭证已经失效或已经使用过。重新打开站点会自动再次发起验证。',
      detail: '如果你刚刚调整过访问权限，请等待几秒后再试。',
      statusLabel: '需要重新验证',
    },
  },
  SITE_SESSION_REQUIRED: {
    status: 403,
    message: 'Site access denied.',
    page: {
      title: '访问验证没有完成',
      message: '站点访问验证还没有完成。重新打开站点会自动再次发起验证。',
      statusLabel: '需要重新验证',
    },
  },
  SITE_SESSION_STALE: {
    status: 403,
    message: 'Site access denied.',
    page: {
      title: '访问验证已过期',
      message: '这次访问验证已经过期。重新打开站点会自动再次发起验证。',
      statusLabel: '需要重新验证',
    },
  },
  SITE_ACCESS_FORBIDDEN: {
    status: 403,
    message: 'Site access denied.',
    page: {
      title: '你暂时没有访问权限',
      message: '当前账号还没有被加入这个站点的访问名单。如果你认为应该可以访问，请联系站点管理员开通权限。',
      statusLabel: '没有访问权限',
    },
  },
  SITE_DISABLED: {
    status: 403,
    message: 'Site access denied.',
    page: {
      title: '站点暂时不可访问',
      message: '这个站点当前没有开放访问。你可以稍后再试，或联系站点管理员确认是否已经启用。',
      detail: '',
      statusLabel: '暂停访问',
      actionLabel: '刷新页面',
      tone: 'default',
    },
  },
  SITE_POLICY_INVALID: {
    status: 403,
    message: 'Site access denied.',
    page: {
      title: '站点访问配置需要确认',
      message: '这个站点的访问策略暂时无法确认。请联系站点管理员检查访问范围配置。',
      statusLabel: '访问策略异常',
    },
  },
  SITE_SESSION_CREATE_FAILED: {
    status: 500,
    message: 'Site session could not be created.',
    page: {
      title: '访问验证没有完成',
      message: '站点访问会话暂时无法创建，请稍后再试。',
      statusLabel: '服务异常',
    },
  },
  SITE_AUTH_RETURN_INVALID: {
    status: 400,
    message: 'Site auth return URL is invalid.',
    page: {
      title: '访问验证没有完成',
      message: '访问验证返回地址无效，请重新打开站点。',
      statusLabel: '需要重新验证',
    },
  },
});

export function siteErrorResponse(request, code, { hostname, message, detail } = {}) {
  const entry = SITE_ERROR_REGISTRY[code] || GENERIC_SITE_ERROR;
  if (!wantsHtml(request)) {
    return jsonResponse({ error: { code, message: message ?? entry.message } }, entry.status, {
      'Cache-Control': 'no-store',
    });
  }

  const page = entry.page;
  return browserPageResponse({
    ...page,
    tone: page.tone || 'danger',
    detail: detail ?? page.detail ?? `状态详情：${code}`,
    status: entry.status,
    actionHref: hostname ? `https://${hostname}/` : '',
    actionLabel: page.actionLabel || '重新打开站点',
  });
}
