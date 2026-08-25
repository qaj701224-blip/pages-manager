# Console 站点归属转移设计

## 背景

站点设置页已经把展示名称与访问地址拆成独立卡片，但旧“设置”卡片仍重复展示站点标题、`Slug` 和 `Hostname`。该卡片的“修改”按钮实际上只允许修改 Owner，导致用户误以为重复字段也可在这里编辑。

Owner 也不是普通 metadata。它决定站点资产归属和管理权限；转移可能使操作者立即失去站点访问权，并会递增 route `policyVersion`、刷新 route snapshot、写入审计事件。现有架构已要求站点归属转移与普通表单分离，并将修改 Owner 定义为需要 recent login 的高风险操作。

## 目标

- 保留“显示信息”和“访问地址”两张独立卡片，删除旧卡片中重复的站点标题、`Slug` 和 `Hostname`。
- 把 Owner 明确呈现为独立的“站点归属”能力，操作文案统一为“转移归属”。
- 个人站点只允许当前个人 Owner 发起转移；团队站点只允许源团队 `admin` 发起转移。
- 当前个人 Owner 可以把站点直接转给另一位 active 用户，或转给自己具备 `publisher` / `admin` 权限的 active 团队，不增加接收确认流程。
- 平台管理员继续可以把任意站点转给任意 active 用户或 active 团队。
- 转移前执行服务端 recent-login 校验和明确的二次确认。
- 权限、目标状态和站点当前归属必须在 site commit lease 内重新校验，避免并发降权或归属变化后仍完成转移。

## 非目标

- 不修改站点名称、slug、hostname、deployment、version 或 runtime config 的行为。
- 不新增转移邀请、接收/拒绝、撤销或归属历史页面。
- 不改变团队 `publisher` 对发布、名称/URL、访问控制和运行配置等其它站点操作的权限。
- 不引入 R2 或缩略图能力。
- 不在本次任务中部署 staging 或 production。

## 产品语义

Owner 表示站点资产的最终归属方：

- `owner.type=user`：归属于一个有效用户。
- `owner.type=team`：归属于一个有效团队，由团队角色决定管理能力。
- 转给其他个人后，原 Owner 不自动保留 collaborator 或 viewer 身份。
- 转给团队后，操作者是否继续拥有管理权限取决于其在目标团队中的当前角色。
- 团队不支持 `visibility=owner`；此类站点必须先修改访问模式，才能转给团队。

### 发起权限

| 当前归属 | Workspace 发起者 | 是否允许 |
| --- | --- | --- |
| 个人 | 当前 Owner | 是 |
| 个人 | 其他用户 | 否 |
| 团队 | 当前团队 `admin` | 是 |
| 团队 | 当前团队 `publisher` / `viewer` | 否 |
| 任意 | platform admin（Admin Console） | 是 |

该源归属规则应在共享 ownership application 中执行，因此 Console、独立 Public transfer API 和 deploy 中隐式触发的既有站点归属转移都不能由团队 `publisher` 绕过。Public API 现有“转个人仅允许转给已认证 actor 自己”和 Team Access Token 限制保持不变；本次只扩展 Console Owner 对其他 active 用户的既有直接转移体验，不扩大非交互凭证权限。

### 目标权限

- Workspace 转给个人：目标必须存在且 `employeeStatus=active`。
- Workspace 转给团队：目标团队必须属于当前环境、状态为 active，且操作者在目标团队中是 `publisher` 或 `admin`。
- Admin Console：目标用户必须 active；目标团队必须在当前环境 active，不要求管理员是团队成员。
- 与当前 Owner 相同的目标是无效请求。前端禁用提交，应用层在持锁后再次拒绝，不递增 `policyVersion`、不刷新 snapshot、不写审计。

## Console 信息架构与交互

站点设置页按以下顺序展示：

1. “显示信息”：仅编辑名称。
2. “访问地址”：编辑 slug，并展示由 slug 推导的 hostname。
3. “站点归属”：展示当前 Owner 类型、名称和必要的邮箱或团队路径。
4. “删除站点”：保留现有危险操作区域。

“站点归属”卡片不再展示站点标题、Slug 或 Hostname。具有 `permissions.canTransferOwnership` 的用户看到“转移归属”按钮；其他用户只看到只读归属和“仅当前个人 Owner 或团队 admin 可转移站点归属”的说明。

点击“转移归属”后，在卡片内展开现有个人/团队选择器：

- 个人候选仅显示 active 用户；不得仅排除 `inactive` 后继续展示 `unknown` 用户。
- 团队候选仅显示操作者具备 `publisher` / `admin` 权限的 active 团队。
- 当前 Owner 不作为可提交目标；未选择目标或选择相同目标时“继续”按钮禁用。
- 点击“继续”后打开共享 `ConfirmDialog`。提交使用打开确认框时冻结的目标 id/type，避免搜索或异步列表刷新改变提交对象。

确认框展示：

- 标题：“确认转移站点归属”。
- 摘要：“当前归属 → 目标归属”。
- 固定说明：“转移会立即改变站点资产归属和管理权限。”
- 若响应预期表明操作者将在转移后失权，额外提示：“转移成功后，你将无法继续访问或管理此站点。”
- 主按钮：“确认转移”；请求中显示“转移中”，并禁止关闭和重复提交。
- API 错误保留在确认框内，不关闭选择状态。

成功后只用响应中的 `owner` 与 `permissions` patch 当前站点，避免覆盖并发发生的 title/slug 更新。Workspace 用户若转移后不再有权访问该站点，使用 replace navigation 返回 `/workspace/published` 并显示成功反馈，避免浏览器返回到已失权详情页；仍属于目标团队的操作者和 platform admin 留在当前详情页。

site id 或 Owner 变化、组件卸载时关闭编辑和确认状态。继续沿用 resource request guard，防止旧站点的迟到响应覆盖当前页面。

## 权限投影

站点详情响应新增：

```json
{
  "permissions": {
    "role": "admin",
    "canManage": true,
    "canManageAccess": true,
    "canTransferOwnership": true
  }
}
```

`canTransferOwnership` 由服务端投影，不由 UI 根据标签猜测：

- 个人站点：当前用户是 Owner 时为 `true`。
- 团队站点：当前用户角色为 `admin` 时为 `true`；`publisher` / `viewer` 为 `false`。
- Admin Console：platform admin 为 `true`。

现有 `canManage` 与 `canManageAccess` 语义不随本次修改改变。

## Recent login

Owner 转移要求 Console 用户最近 15 分钟内重新经过 SSO 验证。校验只在 pages-api 服务端执行，浏览器状态不作为权限依据。

现有 AuthSessionDO 已保存且刷新时不会改变 `authTime`。本次把该权威时间沿以下链路透传：

```text
AuthSessionDO.authTime
  -> console one-time code
  -> internal console exchange
  -> host-only console_session JWT
  -> X-Console-Auth-Time
  -> pages-api validated console session
```

- `authTime` 使用 Unix 秒；缺失、非整数、超出允许的未来时钟偏差或距当前时间超过 15 分钟，转移接口返回 `401 CONSOLE_RECENT_LOGIN_REQUIRED`。
- 旧 Console cookie 可以继续访问普通页面，但对 Owner 转移 fail closed。
- pages-console BFF 继续重建内部请求头，丢弃浏览器伪造的 `X-Console-*`；`X-Console-Auth-Time` 只能来自已验签的 host-bound Console JWT。
- UI 收到 `CONSOLE_RECENT_LOGIN_REQUIRED` 后显示“重新验证身份”操作，跳转到 `/api/console/auth/login?reauth=1&returnTo=<当前站点设置页>`。
- `reauth=1` 传到 pages-auth 后必须跳过现有 `auth_session` 快捷授权，重新经过 SSO authorize/callback，并在新 auth session 中生成新的 `authTime`。向心动 SSO 发送标准 `prompt=login`；即使上游保留自己的登录态，平台也只把本次重新获得的 SSO callback 视为新的验证时刻，不以 Console JWT `iat`、console code `issuedAt` 或 session `lastSeenAt` 代替。
- 回跳后不在 URL、storage 或 cookie 中保存待转移目标。用户需要重新选择并再次确认，避免重认证前的意图被静默执行。

Admin Console 的 Owner 转移使用同一 recent-login 规则。

## 服务端授权与一致性

沿用现有 `createTransferSiteOwner`、site commit lease、owner/route expected tuple、route snapshot 刷新和失败补偿，不另建第二套转移逻辑。

共享 application 在锁内重新读取 actor、站点、源 Owner、目标 Owner 和 route 后执行：

1. 校验 recent login 已由可信 Console session 满足；Public API 不使用浏览器 recent-login 条件。
2. 校验源站点转移权限：个人 Owner 本人，或源团队 `admin`；platform admin bypass。
3. 校验目标用户/团队仍然 active，并重新检查目标团队成员角色。
4. 拒绝与当前 Owner 相同的目标。
5. 校验团队目标与当前 visibility 兼容。
6. 原子更新 Owner、相关 `site_members`、route `policyVersion` 与 `site.owner.transfer` 审计事件。
7. 刷新 active route snapshot；失败沿用现有补偿，恢复旧 Owner，否则返回 repair-required 错误。

为了关闭权限检查与提交之间的竞态，D1 guarded statement 必须表达“源团队角色仍是 admin”；不能只在 handler 或 UI 中判断。目标团队的 `publisher` / `admin` 条件也继续在事务内复核。

## API 与错误语义

Console BFF 暂时保留既有内部路由，避免 pages-console 与 pages-api 非原子部署导致中断：

```text
PATCH /api/console/sites/{siteId}/settings
PATCH /api/console/admin/sites/{siteId}/settings
```

请求体继续为：

```json
{ "ownerType": "user", "ownerId": "usr_xxx" }
{ "ownerType": "team", "teamId": "team_xxx" }
```

路由只承载 Owner 转移；代码命名、测试和文档不再把它描述为通用“站点设置保存”。后续若迁移到 `/transfer`，应另做兼容发布，不在本次 UI 修复中增加路由别名。

需要稳定处理以下错误：

| code | status | UI 行为 |
| --- | ---: | --- |
| `CONSOLE_RECENT_LOGIN_REQUIRED` | 401 | 保留错误并提供“重新验证身份” |
| `SITE_ADMIN_REQUIRED` | 403 | 提示仅个人 Owner 或源团队 admin 可转移 |
| `SITE_TRANSFER_INVALID` | 400 | 提示目标无效或与当前归属相同 |
| `SITE_TRANSFER_FORBIDDEN` | 403 | 提示目标用户/团队不可用或无目标团队权限 |
| `SITE_VISIBILITY_INVALID` | 400 | 提示先把 `owner` visibility 改为团队支持的模式 |
| `SITE_POLICY_CONFLICT` | 409 | 提示站点或权限已变化，刷新后重试 |
| `ROUTE_POLICY_REPAIR_REQUIRED` | 503 | 提示归属未能安全生效，刷新确认后重试 |

不存在或在持锁复核时失权继续返回 `SITE_NOT_FOUND`，避免泄露站点归属。错误响应、日志和 UI 不包含 session、token 或内部 provider 信息。

## 测试

### pages-auth / session-kit

- auth session 刷新不改变 `authTime`。
- 正常 Console 登录完整保留原 `authTime`。
- `reauth=1` 跳过本地 auth-session shortcut，重新走 SSO callback并生成新的 `authTime`。
- Console code、exchange 和 JWT 拒绝缺失类型约束以外的非法时间值。

### pages-console Worker

- BFF 忽略客户端伪造的 `X-Console-Auth-Time`，只转发验签 session 中的值。
- 旧 cookie 仍可读页面，但 Owner 转移会由 pages-api 拒绝并引导重认证。
- reauth 只允许安全的 Workspace/Admin 相对路径作为 `returnTo`。

### pages-api

- `canTransferOwnership` 对个人 Owner、团队 admin、团队 publisher/viewer 和 platform admin 的投影正确。
- missing、stale、future、刚好位于 15 分钟边界内外的 `authTime` 行为稳定。
- 团队 publisher 即使 recent login 也不能转移；团队 admin 可以。
- admin 在获取 lease 后被降为 publisher时，转移失败且不写 Owner、audit 或 snapshot。
- inactive 用户、无权限目标团队、相同 Owner、owner visibility 转团队继续 fail closed。
- Public API 和 deploy 路径无法绕过源团队 admin 规则；原有目标限制保持不变。
- snapshot 写入失败继续恢复旧 Owner。

### UI

- 设置页不再重复显示旧卡片中的 Slug、Hostname 或站点标题。
- 无 `canTransferOwnership` 时不显示转移入口。
- 目标为空或与当前 Owner 相同时不能继续。
- 只有点击确认后才发送一次 PATCH；请求中不可重复提交或关闭弹窗。
- API 错误留在确认框；recent-login 错误提供安全回跳。
- 转给其他个人后 replace 导航；仍有权限时只 patch Owner/permissions 并保留并发 metadata。
- 站点切换或组件卸载后，迟到响应不能写入新页面。
- 共享 Dialog 继续保持滚动位置和焦点恢复，避免设置页面跳动。

## 文档同步

- 更新 `docs/architecture/xd-cell-console.md`：删除“publisher 可转移归属”，说明独立归属卡片和 team admin 权限。
- 更新 `docs/architecture/publishing-and-runtime.md`：补充 Console recent-login 的实际传递与重认证流程。
- 若共享源权限改变 Public transfer API 行为，同步 `apps/pages-api/src/openapi.js`、`docs/api-boundary.md`、CLI/skill 文案和契约测试；不公开 `/openapi.json`。

## 验收标准

- 页面中名称、URL、Owner 各只有一个明确入口。
- 个人当前 Owner 可直接转给另一 active 用户或可管理团队。
- 团队 publisher 不能通过 UI、Console BFF、Public transfer API 或 deploy 路径转移团队站点；团队 admin 可以。
- stale Console session 无法执行转移，重新经过 SSO 验证后可以。
- 转移失败不会留下部分 Owner、policy、snapshot 或审计状态。
- 转移导致操作者失权时，页面不会继续展示不可访问站点的详情。
- focused tests、`pnpm lint` 和 `pnpm test` 全部通过。
