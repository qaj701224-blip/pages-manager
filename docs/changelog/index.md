# Changelog

## 2026-05-18 域名迁移：xd-ads.com → workers.xd.team

### 背景

将站点域名从 `{name}-page.xd-ads.com` 迁移到 `{name}.workers.xd.team`，管理 API 从 `pages-api.xd-ads.com` 迁移到 `api.workers.xd.team`。旧域名通过 308 永久跳转到新域名，确保历史链接不断。

### 迁移原因

- `xd-ads.com` 是历史遗留域名，与当前业务无关
- `workers.xd.team` 归属清晰，便于内部识别和管理
- 统一到公司主域名 `xd.team` 下

### 变更内容

#### 域名绑定方式

| 项目 | 旧 | 新 |
|------|-----|-----|
| 站点域名 | `{name}-page.xd-ads.com`（Custom Domain） | `{name}.workers.xd.team`（Workers Route） |
| 管理 API | `pages-api.xd-ads.com`（Custom Domain） | `api.workers.xd.team`（Custom Domain） |
| 域名格式 | 站点名在子域名前缀，后缀 `-page` | 站点名直接作为子域名 |

#### DNS 配置（DNSPod）

在 `xd.team` zone 新增：

| 记录 | 类型 | 值 |
|------|------|-----|
| `workers` | CNAME | `workers.xd.team.cdn.cloudflare.net.` |
| `*.workers` | CNAME | `workers.xd.team.cdn.cloudflare.net.` |
| `_acme-challenge.workers` | CNAME | `workers.xd.team.<token>.dcv.cloudflare.com.` |

#### SSL 证书

`*.workers.xd.team` 是二级子域名，CF Universal SSL（`*.xd.team`）不覆盖。通过 CF Dashboard 签发 Advanced Certificate（Google Trust Services，3 个月有效期，CF 自动续期）。DCV 委派通过 `_acme-challenge.workers` CNAME 实现自动验证。

#### 308 跳转

部署 `xdads-302` Worker 处理旧域名跳转：

- `*-page.xd-ads.com/*` → `{name}.workers.xd.team/*`（308）
- `pages-api.xd-ads.com/*` → `api.workers.xd.team/*`（308）

308 保留 HTTP 方法，对 POST 请求（如部署接口）也安全。

#### 代码变更

| 文件 | 说明 |
|------|------|
| `server/wrangler.toml` | 环境变量 `DOMAIN_BASE=workers.xd.team`，Custom Domain 改为 `api.workers.xd.team` |
| `server/src/lib/cf-api.js` | 新增 `bindRoute()` 替代 `bindDomain()`，新站点使用 Workers Route |
| `server/src/handlers/deploy.js` | 调用 `bindRoute()` 绑定到 `xd.team` zone |
| `server/src/handlers/openapi.js` | API 地址、脚本默认值全量替换 |
| `server/src/router.js` | 修复 HEAD 请求不匹配 GET 路由导致 404 的问题 |
| `pages-deploy.skill.md` | 域名引用更新 |
| `scripts/deploy.sh` / `manage.sh` | 默认 API 地址更新 |
| `README.md` / `API.md` | 文档域名全量更新 |
| `xdads-302/` | 新增 308 跳转 Worker |
| `scripts/migrate-domain.sh` | 一次性迁移脚本，批量创建 Workers Route + 更新 KV 记录 |

#### 迁移数据

- 迁移站点数：30（全部成功）
- Worker 不存在的 KV 残留记录：9（未处理，可能属于其他用户）
- 跳过：1（`test`，Custom Domain 锚点已替换为 `api.workers.xd.team`）

### 关键决策

1. **Workers Route 而非 Custom Domain**：新站点使用 Workers Route 绑定域名。Route 支持通配符匹配，且不需要为每个 hostname 单独签发证书。zone 级 Advanced Certificate 覆盖所有 `*.workers.xd.team`。

2. **Custom Domain 锚定 CNAME**：在 partial zone（CNAME setup）下，`*.workers.xd.team` 的 CNAME 目标 `workers.xd.team.cdn.cloudflare.net` 需要至少一个 Custom Domain 绑定才能生成 A 记录。`api.workers.xd.team` 作为永久存在的管理 API 承担此角色。

3. **308 而非 301/302**：308 Permanent Redirect 保留原始 HTTP 方法。部署接口是 POST multipart，302 会导致浏览器/客户端将 POST 降级为 GET，破坏功能。

### 踩坑记录

1. **Custom Domain 优先级高于 Workers Route**：移除旧 Custom Domain 前，xdads-302 的通配 Route 无法拦截旧域名流量。迁移顺序必须是：先创建新 Route → 验证新域名可达 → 再处理旧 Custom Domain。

2. **过早移除旧 API Custom Domain 导致服务中断**：部署 pages-manager 时移除了 `pages-api.xd-ads.com` Custom Domain，导致 xdads-302 接管并 308 跳转到 DNS 尚未生效的新域名，API 不可达约 10 分钟。教训：新域名完全确认可达后才能切断旧域名。

3. **Partial zone CNAME 目标无 A 记录**：`xd.team.cdn.cloudflare.net` 不返回 A 记录（根域名未被 CF 代理），必须指向 `workers.xd.team.cdn.cloudflare.net`（需要 Custom Domain 绑定才会生成）。

4. **二级子域名证书**：`*.workers.xd.team` 不被 Universal SSL（`*.xd.team`）覆盖，需单独签发 Advanced Certificate。

5. **HEAD 请求 404**：Router 严格匹配 HTTP method，HEAD 找不到 GET 路由返回 404。修复：HEAD 自动 fallback 到 GET 路由。

### 清理项

| 项目 | 状态 |
|------|------|
| `test-domain/` 目录 | 已删除 |
| `pages-domain-test` Worker | 已从 CF 删除 |
| 旧 Custom Domain 绑定（各站点 `xd-ads.com`）| 已被 xdads-302 Route 覆盖，功能上不影响，后续可逐步清理 |
| 旧 `CF_ZONE_ID` secret | 代码已不引用，可通过 `wrangler secret delete` 清理 |
