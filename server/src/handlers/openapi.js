import { applyPublicConfig, getPublicConfig } from '../lib/public-config.js';

const BASE_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Pages — 内部站点托管服务',
    description:
      '将静态站点、SPA 应用或自定义 Worker 一键发布到 {name}.workers.xd.team。' +
      '支持三种 preset: static（纯静态）、spa（单页应用，404 回退 index.html）、worker（自定义 Worker 入口，可做 SSR/API 代理）。' +
      '\n\n站点名称规则: 小写字母、数字、连字符，2-50 字符，首尾不能是连字符。正则: `^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$`' +
      '\n\n域名格式: `https://{name}.workers.xd.team`' +
      '\n\n同名站点可直接覆盖部署，无需先删除。' +
      '\n\n## Token 身份标记' +
      '\n\n所有请求建议携带 `X-Pages-Token` 请求头，用于标记部署者身份。' +
      '格式: `pages_你的邮箱`（如 `pages_zhangsan@xd.com`）。' +
      '\n\nToken 用途:' +
      '\n- 标记站点归属，方便追溯谁部署了哪些站点' +
      '\n- 通过 `GET /list?token=xxx` 或 `X-Pages-Token` 头筛选自己的站点' +
      '\n- 如果未提供 token，部署仍会成功，但响应会包含 warning 提醒设置' +
      '\n\n**重要**: AI 助手应在首次使用时引导用户生成 token（基于邮箱），并将 token 持久化到本地记忆中，后续所有请求自动携带。' +
      '\n\n**域名说明**: 站点域名为 `workers.xd.team`，请以本 spec 中 `servers[0].url` 和实际返回的 URL 为准，不要硬编码域名。',
    version: '1.1.0',
  },
  servers: [{ url: 'https://api.workers.xd.team', description: '生产环境' }],
  paths: {
    '/deploy': {
      post: {
        summary: '部署站点',
        description:
          '上传文件并发布为一个站点 Worker。请求体为 multipart/form-data，包含站点名、preset 和所有要部署的文件。' +
          '\n\n使用 worker preset 时，上传文件中必须包含一个 filename=_worker.js 的文件作为 Worker 入口脚本。' +
          '该脚本可通过 env.ASSETS.fetch(request) 访问同时上传的其他静态文件。' +
          '\n\n站点名即 URL 前缀（如 name=my-app → https://my-app.workers.xd.team）。部署前应询问用户想要的站点名。' +
          '\n\n**归属保护**: 同名站点已被其他用户（不同 token）占用时，返回 409 错误。同一 token 可覆盖自己的站点。' +
          '\n\n**部署记录**: 部署成功后，AI 应在项目目录写入 `.pages.json` 文件记录部署信息（name、url、devUrl、preset、token、updatedAt），' +
          '下次部署同一项目时先读取此文件，自动使用已有的站点名，无需再次询问。文件示例: `{"name":"my-app","url":"https://my-app.workers.xd.team","preset":"static"}`' +
          '\n\n建议携带 X-Pages-Token 头标记部署者身份，否则响应会包含 warning 字段提醒设置。',
        parameters: [{ $ref: '#/components/parameters/PagesToken' }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: {
                    type: 'string',
                    pattern: '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$',
                    description:
                      '站点名称。小写字母、数字、连字符，2-50 字符，首尾不能是连字符。部署后的访问地址为 https://{name}.workers.xd.team',
                    example: 'q2-report',
                  },
                  preset: {
                    type: 'string',
                    enum: ['static', 'spa', 'worker'],
                    default: 'static',
                    description:
                      'static: 按路径匹配文件，未匹配返回 404 页面。' +
                      'spa: 路径未匹配时回退到 index.html，适合 Vue/React/Angular。' +
                      'worker: 使用上传的 _worker.js 作为 Worker 入口，可做 SSR、API 代理、动态渲染。',
                  },
                  token: {
                    type: 'string',
                    description: '部署者 token（备选方式，优先使用 X-Pages-Token 请求头）。格式: pages_你的邮箱',
                    example: 'pages_zhangsan@xd.com',
                  },
                  ip_restrict: {
                    type: 'string',
                    enum: ['true', 'false'],
                    default: 'true',
                    description:
                      'IP 内网限制，默认开启。站点仅允许 IP_ALLOWLIST 中配置的来源访问。' +
                      'static/spa preset 自动注入 IP 检查代码；worker preset 会注入 env.IP_ALLOWLIST，' +
                      '但需在 _worker.js 中自行调用 x-libs.ip-guard。' +
                      '设为 false 可关闭限制，允许公网访问。',
                  },
                  'file-*': {
                    type: 'string',
                    format: 'binary',
                    description:
                      '要部署的文件。字段名任意（如 file-0, file-1），通过 filename 参数指定文件的相对路径（如 filename=assets/style.css）。' +
                      '至少上传一个文件（worker preset 且无静态文件时，_worker.js 自身即满足要求）。',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '部署成功。如果未提供 token，响应会包含 warning 字段提醒设置。',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeployResult' },
                examples: {
                  withToken: {
                    summary: '携带 token 的部署',
                    value: {
                      status: 'ok',
                      name: 'q2-report',
                      url: 'https://q2-report.workers.xd.team',
                      devUrl: 'https://pages-q2-report.xd-cf-2022.workers.dev',
                      fileCount: 42,
                      preset: 'static',
                    },
                  },
                  withoutToken: {
                    summary: '未携带 token 的部署（含 warning）',
                    value: {
                      status: 'ok',
                      name: 'q2-report',
                      url: 'https://q2-report.workers.xd.team',
                      devUrl: 'https://pages-q2-report.xd-cf-2022.workers.dev',
                      fileCount: 42,
                      preset: 'static',
                      warning:
                        '未提供 token。建议设置 X-Pages-Token 请求头（格式: pages_你的邮箱），用于追溯部署记录和查询自己的站点。请让 AI 在本地记住你的 token。',
                    },
                  },
                },
              },
            },
          },
          400: {
            description: '请求参数错误',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidationError' },
                examples: {
                  invalidName: {
                    summary: '站点名称不合法',
                    value: {
                      error: '无效的站点名称',
                      field: 'name',
                      constraint: '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$',
                      hint: '仅限小写字母、数字、连字符，2-50 字符，首尾不能是连字符',
                    },
                  },
                  invalidPreset: {
                    summary: 'preset 值不合法',
                    value: {
                      error: '无效的 preset',
                      field: 'preset',
                      value: 'ssr',
                      valid: ['static', 'spa', 'worker'],
                    },
                  },
                  missingWorker: {
                    summary: 'worker preset 缺少 _worker.js',
                    value: {
                      error: '缺少 _worker.js',
                      field: 'files',
                      hint: '使用 worker preset 时，上传文件中必须包含 filename=_worker.js 的文件作为 Worker 入口',
                    },
                  },
                  noFiles: {
                    summary: '未上传任何文件',
                    value: {
                      error: '未收到文件',
                      field: 'files',
                      hint: '至少上传一个文件，使用 multipart/form-data 格式，文件字段名任意，filename 参数为文件相对路径',
                    },
                  },
                },
              },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          409: {
            description: '站点名已被其他用户占用',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidationError' },
                example: {
                  error: '站点名称已被占用',
                  field: 'name',
                  name: 'my-app',
                  owner: 'pages_other@xd.com',
                  hint: '该名称已被 pages_other@xd.com 使用，请换一个名称',
                },
              },
            },
          },
          500: { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/list': {
      get: {
        summary: '列出已部署站点',
        description:
          '返回站点列表。支持通过 token 参数或 X-Pages-Token 头筛选特定用户的站点。' +
          '\n\n不传 token 时返回所有站点；传 token 时只返回该 token 部署的站点。',
        parameters: [
          { $ref: '#/components/parameters/PagesToken' },
          {
            name: 'token',
            in: 'query',
            description: '按部署者 token 筛选站点（备选方式，也可用 X-Pages-Token 头）',
            schema: { type: 'string' },
            example: 'pages_zhangsan@xd.com',
          },
        ],
        responses: {
          200: {
            description: '站点列表',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sites: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/SiteSummary' },
                    },
                    filtered: {
                      type: 'boolean',
                      description: '是否按 token 筛选了结果',
                    },
                  },
                },
                example: {
                  sites: [
                    {
                      name: 'q2-report',
                      url: 'https://q2-report.workers.xd.team',
                      preset: 'static',
                      token: 'pages_zhangsan@xd.com',
                      updatedAt: '2026-05-13T10:00:00.000Z',
                    },
                  ],
                  filtered: true,
                },
              },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/site/{name}': {
      get: {
        summary: '查询站点详情',
        description: '返回指定站点的完整元数据，包含部署者 token、Worker 名称、文件数、创建和更新时间。',
        parameters: [{ $ref: '#/components/parameters/SiteName' }],
        responses: {
          200: {
            description: '站点详情',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SiteDetail' },
                example: {
                  name: 'q2-report',
                  preset: 'static',
                  scriptName: 'pages-q2-report',
                  url: 'https://q2-report.workers.xd.team',
                  devUrl: 'https://pages-q2-report.xd-cf-2022.workers.dev',
                  fileCount: 42,
                  token: 'pages_zhangsan@xd.com',
                  createdAt: '2026-05-13T10:00:00.000Z',
                  updatedAt: '2026-05-13T12:00:00.000Z',
                },
              },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: {
            description: '站点不存在',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotFoundError' },
                example: {
                  error: '站点不存在',
                  name: 'q2-report',
                  hint: '使用 GET /list 查看所有已部署站点',
                },
              },
            },
          },
        },
      },
      delete: {
        summary: '删除站点',
        description: '删除指定站点的 Worker 和域名绑定，同时清除 KV 中的元数据。此操作不可逆。',
        parameters: [{ $ref: '#/components/parameters/SiteName' }],
        responses: {
          200: {
            description: '删除成功',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    name: { type: 'string', example: 'q2-report' },
                    message: { type: 'string', example: '站点 q2-report 已删除' },
                  },
                },
              },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: {
            description: '站点不存在',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NotFoundError' },
                example: {
                  error: '站点不存在',
                  name: 'q2-report',
                  hint: '使用 GET /list 查看所有已部署站点',
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        summary: '健康检查',
        description: '返回服务运行状态。可用于监控和连通性测试。',
        responses: {
          200: {
            description: '服务正常',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      SiteName: {
        name: 'name',
        in: 'path',
        required: true,
        description: '站点名称，与部署时使用的 name 一致',
        schema: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$',
        },
        example: 'q2-report',
      },
      PagesToken: {
        name: 'X-Pages-Token',
        in: 'header',
        description:
          '部署者身份标记。格式: pages_你的邮箱（如 pages_zhangsan@xd.com）。' +
          '首次使用时，AI 应引导用户提供邮箱，生成 token 并持久化到本地记忆中，后续所有请求自动携带。',
        schema: { type: 'string' },
        example: 'pages_zhangsan@xd.com',
      },
    },
    schemas: {
      DeployResult: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '固定值 "ok"' },
          name: { type: 'string', description: '站点名称' },
          url: { type: 'string', format: 'uri', description: '站点访问地址（自定义域名）' },
          devUrl: { type: 'string', format: 'uri', description: 'workers.dev 备用地址，无需 DNS 配置即可访问' },
          fileCount: { type: 'integer', description: '部署的文件数量（不含 _worker.js）' },
          preset: { type: 'string', enum: ['static', 'spa', 'worker'] },
          ipRestrict: { type: 'boolean', description: '是否已开启 IP 内网限制' },
          warning: { type: 'string', description: '提醒信息（未提供 token、worker preset 需调用 IP 限制 helper 等）' },
        },
      },
      SiteSummary: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          preset: { type: 'string', enum: ['static', 'spa', 'worker'] },
          token: { type: 'string', description: '部署者 token（可能为 null）' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      SiteDetail: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          preset: { type: 'string', enum: ['static', 'spa', 'worker'] },
          scriptName: { type: 'string', description: '内部 Worker 名称（pages-{name}）' },
          url: { type: 'string', format: 'uri' },
          devUrl: { type: 'string', format: 'uri', description: 'workers.dev 备用地址' },
          fileCount: { type: 'integer' },
          token: { type: 'string', description: '部署者 token（可能为 null）' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ValidationError: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string', description: '错误描述' },
          field: { type: 'string', description: '出错的字段名' },
          value: { description: '用户提交的值（仅在值可安全回显时提供）' },
          constraint: { type: 'string', description: '字段的约束规则（如正则表达式）' },
          valid: { type: 'array', items: { type: 'string' }, description: '合法值列表' },
          hint: { type: 'string', description: '修正建议' },
        },
      },
      NotFoundError: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          name: { type: 'string', description: '请求的站点名称' },
          hint: { type: 'string', description: '修正建议' },
        },
      },
      RouteError: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          method: { type: 'string' },
          path: { type: 'string' },
          hint: { type: 'string' },
        },
      },
    },
    responses: {
      Forbidden: {
        description: 'IP 未授权',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string', example: 'IP 未授权' },
                ip: { type: 'string', description: '系统识别到的请求 IP', example: '203.0.113.1' },
                hint: {
                  type: 'string',
                  example:
                    '该 IP 不在内网白名单内。WebFetch 等工具的出口 IP 可能不在白名单，请改用 curl 命令行直接请求（curl 走用户本机网络）。',
                },
              },
            },
          },
        },
      },
      InternalError: {
        description: '服务端错误（通常为 Cloudflare API 调用失败）',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                error: { type: 'string', description: '错误描述' },
                errors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      code: { type: 'integer' },
                      message: { type: 'string' },
                    },
                  },
                  description: 'Cloudflare API 返回的错误详情（仅在 CF API 报错时存在）',
                },
              },
            },
          },
        },
      },
    },
  },
  'x-skill-version': '1.5.0',
  'x-libs': {
    description: '可复用的代码片段。worker preset 用户可参考这些代码在 _worker.js 中集成对应功能。',
    'ip-guard': {
      description:
        'IP 内网限制代码。worker preset 不会自动改写用户上传的 _worker.js；' +
        '部署时 pages-manager 会将白名单注入到子 Worker 的 env.IP_ALLOWLIST。' +
        '在 Worker fetch handler 开头调用 checkIP(request, env)，' +
        '返回非 null 则直接 return（403）。',
      usage: 'const blocked = checkIP(request, env); if (blocked) return blocked;',
      source: [
        'function getAllowed(env) {',
        '  return String(env.IP_ALLOWLIST || "")',
        '    .split(",")',
        '    .map((entry) => entry.trim())',
        '    .filter(Boolean);',
        '}',
        '',
        'function ipToInt(ip) {',
        '  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;',
        '}',
        '',
        'function toRules(allowed) {',
        '  return allowed.map((entry) => {',
        '  if (entry.includes(":")) return { type: "exact6", value: entry };',
        '  if (entry.includes("/")) {',
        '    const [base, bits] = entry.split("/");',
        '    const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;',
        '    return { type: "cidr", network: ipToInt(base) & mask, mask };',
        '  }',
        '  return { type: "exact4", value: ipToInt(entry) };',
        '  });',
        '}',
        '',
        'function checkIP(request, env) {',
        '  const rules = toRules(getAllowed(env));',
        '  const ip = request.headers.get("CF-Connecting-IP");',
        '  if (!ip) return null;',
        '  if (ip.includes(":")) {',
        '    return rules.some((r) => r.type === "exact6" && r.value === ip)',
        '      ? null',
        '      : new Response("IP not allowed", { status: 403 });',
        '  }',
        '  const n = ipToInt(ip);',
        '  const ok = rules.some((r) => {',
        '    if (r.type === "exact4") return r.value === n;',
        '    if (r.type === "cidr") return (n & r.mask) === r.network;',
        '    return false;',
        '  });',
        '  return ok ? null : new Response("IP not allowed", { status: 403 });',
        '}',
      ].join('\n'),
    },
  },
  'x-scripts': {
    description:
      'CLI 辅助脚本。AI 可下载保存到本地后直接执行，免去手动构造 multipart 请求。' +
      '脚本通过环境变量 PAGES_TOKEN 传递身份 token，PAGES_API 可覆盖 API 地址。',
    deploy: {
      filename: 'pages-deploy.sh',
      description: '部署脚本: pages-deploy.sh <name> <dir> [--preset static|spa|worker] [--public]',
      usage: 'PAGES_TOKEN=pages_xxx@xd.com bash pages-deploy.sh my-site ./dist --preset static',
      source: [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        'NAME="${1:-}"',
        'DIR="${2:-}"',
        'PRESET="static"',
        'IP_RESTRICT="true"',
        'API="${PAGES_API:-https://api.workers.xd.team}"',
        '',
        'shift 2 2>/dev/null || true',
        'while [[ $# -gt 0 ]]; do',
        '  case "$1" in',
        '    --preset) PRESET="${2:-static}"; shift 2 ;;',
        '    --public) IP_RESTRICT="false"; shift ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        '',
        'if [ -z "$NAME" ] || [ -z "$DIR" ]; then',
        '  echo "用法: pages-deploy.sh <name> <dir> [--preset static|spa|worker] [--public]"',
        '  exit 1',
        'fi',
        '',
        'if [ ! -d "$DIR" ]; then',
        '  echo "错误: 目录 \'$DIR\' 不存在"',
        '  exit 1',
        'fi',
        '',
        'DIR="$(cd "$DIR" && pwd)"',
        '',
        'CURL_ARGS=(-s -w "\\n%{http_code}" -X POST)',
        'if [ -n "${PAGES_TOKEN:-}" ]; then',
        '  CURL_ARGS+=(-H "X-Pages-Token: ${PAGES_TOKEN}")',
        'fi',
        'CURL_ARGS+=(-F "name=${NAME}")',
        'CURL_ARGS+=(-F "preset=${PRESET}")',
        'CURL_ARGS+=(-F "ip_restrict=${IP_RESTRICT}")',
        '',
        'COUNT=0',
        "while IFS= read -r -d '' file; do",
        '  rel="${file#"$DIR"/}"',
        '  CURL_ARGS+=(-F "file-${COUNT}=@${file};filename=${rel}")',
        '  COUNT=$((COUNT + 1))',
        'done < <(find "$DIR" -type f -print0)',
        '',
        'if [ "$COUNT" -eq 0 ]; then',
        '  echo "错误: 目录为空"',
        '  exit 1',
        'fi',
        '',
        'echo "正在部署 ${DIR} → ${NAME} (${PRESET}, ${COUNT} 个文件)..."',
        '',
        'RESPONSE=$(curl "${CURL_ARGS[@]}" "${API}/deploy")',
        'HTTP_CODE=$(echo "$RESPONSE" | tail -1)',
        'BODY=$(echo "$RESPONSE" | sed \'$d\')',
        '',
        'if [ "$HTTP_CODE" = "200" ]; then',
        '  URL=$(echo "$BODY" | grep -o \'"url":"[^"]*"\' | cut -d\'"\' -f4)',
        '  echo ""',
        '  echo "✅ 已发布: ${URL}"',
        '  echo "   文件数: ${COUNT}"',
        '  echo "   类型: ${PRESET}"',
        'else',
        '  echo ""',
        '  echo "❌ 部署失败 (HTTP ${HTTP_CODE})"',
        '  echo "$BODY"',
        '  exit 1',
        'fi',
      ].join('\n'),
    },
    manage: {
      filename: 'pages-manage.sh',
      description: '管理脚本: pages-manage.sh list | info <name> | delete <name>',
      usage: 'PAGES_TOKEN=pages_xxx@xd.com bash pages-manage.sh list',
      source: [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        'CMD="${1:-}"',
        'API="${PAGES_API:-https://api.workers.xd.team}"',
        'TOKEN_HEADER=()',
        'if [ -n "${PAGES_TOKEN:-}" ]; then',
        '  TOKEN_HEADER=(-H "X-Pages-Token: ${PAGES_TOKEN}")',
        'fi',
        '',
        'case "$CMD" in',
        '  list)',
        '    curl -s "${TOKEN_HEADER[@]}" "${API}/list" | python3 -m json.tool 2>/dev/null \\',
        '      || curl -s "${TOKEN_HEADER[@]}" "${API}/list"',
        '    ;;',
        '  info)',
        '    NAME="${2:-}"',
        '    [ -z "$NAME" ] && echo "用法: pages-manage.sh info <name>" && exit 1',
        '    RESPONSE=$(curl -s "${TOKEN_HEADER[@]}" -w "\\n%{http_code}" "${API}/site/${NAME}")',
        '    HTTP_CODE=$(echo "$RESPONSE" | tail -1)',
        '    BODY=$(echo "$RESPONSE" | sed \'$d\')',
        '    if [ "$HTTP_CODE" = "200" ]; then',
        '      echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"',
        '    else',
        '      echo "站点 \'${NAME}\' 不存在"',
        '      exit 1',
        '    fi',
        '    ;;',
        '  delete)',
        '    NAME="${2:-}"',
        '    [ -z "$NAME" ] && echo "用法: pages-manage.sh delete <name>" && exit 1',
        '    if [ "${3:-}" != "--yes" ]; then',
        '      read -r -p "确认删除站点 \'${NAME}\'? (y/N) " confirm',
        '      [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && echo "已取消" && exit 0',
        '    fi',
        '    RESPONSE=$(curl -s "${TOKEN_HEADER[@]}" -w "\\n%{http_code}" -X DELETE "${API}/site/${NAME}")',
        '    HTTP_CODE=$(echo "$RESPONSE" | tail -1)',
        '    BODY=$(echo "$RESPONSE" | sed \'$d\')',
        '    if [ "$HTTP_CODE" = "200" ]; then',
        '      echo "✅ 站点 \'${NAME}\' 已删除"',
        '    else',
        '      echo "❌ 删除失败 (HTTP ${HTTP_CODE})"',
        '      echo "$BODY"',
        '      exit 1',
        '    fi',
        '    ;;',
        '  *)',
        '    echo "用法: pages-manage.sh list | info <name> | delete <name>"',
        '    exit 1',
        '    ;;',
        'esac',
      ].join('\n'),
    },
  },
};

export function buildOpenAPISpec(request, env) {
  const config = getPublicConfig(request, env);
  const spec = applyPublicConfig(BASE_SPEC, config);

  spec.servers = [{ url: config.apiBase, description: `${config.environment} 环境` }];
  spec['x-public-config'] = {
    environment: config.environment,
    apiBase: config.apiBase,
    domainBase: config.domainBase,
    domainLabel: config.domainLabel,
    workerPrefix: config.workerPrefix,
    managerWorkerName: config.managerWorkerName,
  };

  return spec;
}

export function handleOpenAPI(request, env) {
  return new Response(JSON.stringify(buildOpenAPISpec(request, env), null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
