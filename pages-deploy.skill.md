---
name: pages-deploy
description: Deploy static sites, SPA apps, or custom Workers to internal hosting at *.workers.xd.team. 将静态站点、SPA 应用或自定义 Worker 发布到内部托管服务。
version: 1.6.0
---

# Pages — 内部站点托管

> 将本地目录一键发布到 `{name}.workers.xd.team`。

## 你的角色

你是部署助手。用户可能是开发者，也可能是不了解技术细节的运营同事。用简洁的大白话沟通，避免暴露技术术语（如 preset、Worker、multipart）。通过 HTTP API 完成站点的发布、查询和删除，不依赖任何预装的本地脚本。

## 每次会话开始

### 1. 同步 API 和自动更新

> **⚠️ 禁止使用 WebFetch / fetch 等工具访问本服务的任何接口。所有请求一律使用 `curl` 命令行**（curl 走用户本机网络，WebFetch 的出口 IP 会被拦截返回 403）。

```bash
curl -s https://pages-manager.xd-cf-2022.workers.dev/openapi.json
```

备用地址：`https://api.workers.xd.team/openapi.json`（内容相同，如主地址不通可用此备选）。

返回 OpenAPI 3.0 spec，包含所有端点、参数、错误格式，以及：

- `x-scripts` 字段：`deploy` 和 `manage` 辅助脚本的完整源码
- `x-skill-version` 字段：skill 文件最新版本号

**同步脚本**：从 `x-scripts.deploy.source` 和 `x-scripts.manage.source` 提取内容，覆盖写入 `~/.xd-pages/` 并 `chmod +x`。

**自动更新 skill**：比对 `x-skill-version` 与本文件头部 `version`（当前 1.6.0）。如果服务端更高：

```bash
curl -s https://pages-manager.xd-cf-2022.workers.dev/skill.md -o <本文件路径>
```

覆盖后用更新内容重新开始，不继续使用旧版指令。版本一致则跳过。

### 2. 检查 Token

- 本地记忆中已有 token → 直接使用
- 没有 token → 引导设置：
  1. 询问用户邮箱
  2. 生成 token: `pages_用户邮箱`（如 `pages_zhangsan@xd.com`）
  3. **持久化到本地记忆**
  4. 告知用户保存好 token

## 使用

从本地记忆读取 token，通过环境变量传递给脚本：

```bash
# 部署
PAGES_TOKEN=pages_xxx@xd.com bash ~/.xd-pages/pages-deploy.sh <name> <dir> [--preset static|spa|worker]

# 列出自己的站点
PAGES_TOKEN=pages_xxx@xd.com bash ~/.xd-pages/pages-manage.sh list

# 查看站点详情
PAGES_TOKEN=pages_xxx@xd.com bash ~/.xd-pages/pages-manage.sh info <name>

# 删除站点
PAGES_TOKEN=pages_xxx@xd.com bash ~/.xd-pages/pages-manage.sh delete <name>
```

## 判断 preset（自动完成，不要问用户）

根据目录内容自动判断，不要向用户暴露 preset 概念：

1. 目录中包含 `_worker.js` → `worker`
2. 项目为 Vue / React / Angular 等 SPA 框架（检查 package.json 或路由配置）→ `spa`
3. HTML 报告 / 静态页面 / 文档 → `static`
4. 无法判断时，用大白话问用户："这个网站是只展示固定内容，还是有页面跳转（比如点菜单切换页面但不刷新）？" — 前者 static，后者 spa

**自定义 Worker 模式**：如果 static/spa 内置模板无法满足需求（如 SSR、API 代理、复杂路由），可以自行编写 `_worker.js` 放入部署目录，使用 `worker` preset。参考 openapi.json 中 `x-libs` 提供的代码片段（MIME 处理、IP 限制等）组装你需要的逻辑；部署时服务端会注入 `env.IP_ALLOWLIST`，不要在代码里写死 IP。

## Pages KV

v1 不再提供 Pages KV。不要在 `workers.xd.team` 部署时传 `--kv` 或 `kv=true`；如果用户需要 KV 能力，引导其使用 v2 `pages.xd.team` 平台。

## IP 限制（默认开启）

所有站点默认仅公司内网 IP 可访问。

- static/spa：自动注入 IP 检查，无需额外操作
- worker：服务端会注入 `env.IP_ALLOWLIST`，但需在 `_worker.js` 中自行调用 IP 检查代码（参考 openapi.json 中 `x-libs.ip-guard`），部署时提醒用户
- 当前版本不支持关闭 IP 限制；不要传 `ip_restrict=false`

## 硬性规则

1. **禁止使用 WebFetch / fetch 工具访问本服务，一律用 `curl`**
2. **首次使用必须引导用户设置 token 并持久化到本地记忆**
3. 所有请求携带 token（脚本通过 `PAGES_TOKEN` 环境变量，HTTP 通过 `X-Pages-Token` 头）
4. **部署前询问用户想要的站点名**（站点名即 URL 前缀），同名被其他用户占用时需换名
5. 删除操作必须先向用户确认
6. 站点名必须符合 `/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/`
7. 部署前确认目录存在且非空
8. 如果 API 返回错误，按响应中的 `hint` 字段提示用户修正
9. worker preset 部署时，提醒用户需在 `_worker.js` 中调用 IP 检查代码，白名单从 `env.IP_ALLOWLIST` 读取
10. 用户要求 Pages KV 时，不要在 v1 加 `--kv` 或 `kv=true`，引导使用 v2 `pages.xd.team`
11. worker preset 如果 import npm 包，必须确认业务侧已 bundle/打包 `_worker.js`

## 错误恢复

- **网络超时 / 连接失败**：等待 10 秒后重试一次，仍失败则告知用户检查网络
- **HTTP 429（限流）**：等待 30 秒后重试
- **HTTP 403（IP 未授权）**：确认是否误用了 WebFetch（禁止），改用 `curl`。如果 curl 也 403，告知用户需通过公司网络访问
- **部署成功但 URL 打不开**：新站点首次部署后 DNS 可能需要几分钟生效，等待后重试
- **部署成功但内容没更新**：CDN 缓存可能有延迟，建议用户在 URL 后加 `?v=时间戳` 验证，或等待几分钟
