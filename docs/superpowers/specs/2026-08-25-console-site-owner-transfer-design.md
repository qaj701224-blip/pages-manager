# Console 站点归属转移设计

## 背景

站点设置页已经把展示名称与访问地址拆成独立卡片，但旧“设置”卡片仍重复展示站点标题、`Slug` 和 `Hostname`。该卡片的“修改”按钮实际上只允许修改 Owner，导致用户误以为重复字段也可在这里编辑。

Owner 也不是普通 metadata。它决定站点资产归属和管理权限；转移可能使操作者立即失去站点访问权，并会递增 route `policyVersion`、刷新 route snapshot、写入审计事件。站点归属转移因此与普通表单分离，并通过明确风险提示和二次确认防止误操作，不额外要求重新验证身份。

## 目标

- 保留“显示信息”和“访问地址”两张独立卡片，删除旧卡片中重复的站点标题、`Slug` 和 `Hostname`。
- 把 Owner 明确呈现为独立的“站点归属”能力，操作文案统一为“转移归属”。
- 个人站点只允许当前个人 Owner 发起转移；团队站点只允许源团队 `admin` 发起转移。
- 当前个人 Owner 可以把站点直接转给另一位 active 用户，或转给自己具备 `publisher` / `admin` 权限的 active 团队，不增加接收确认流程。
- 平台管理员继续可以把任意站点转给任意 active 用户或 active 团队。
- 转移前展示明确的风险提示并要求二次确认，不增加 recent-login 身份验证。
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

| 当前归属 | Workspace 发起者                | 是否允许 |
| -------- | ------------------------------- | -------- |
| 个人     | 当前 Owner                      | 是       |
| 个人     | 其他用户                        | 否       |
| 团队     | 当前团队 `admin`                | 是       |
| 团队     | 当前团队 `publisher` / `viewer` | 否       |
| 任意     | platform admin（Admin Console） | 是       |

该源归属规则应在共享 ownership application 中执行，因此 Console、独立 Public transfer API 和 deploy 中隐式触发的既有站点归属转移都不能由团队 `publisher` 绕过。各入口行为如下：

| 入口/凭证                                      | 个人源站点     | 团队源站点                                          | 目标个人                          | 目标团队                                  | 源权限不足的外部错误                                                  |
| ---------------------------------------------- | -------------- | --------------------------------------------------- | --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| Workspace Console                              | 当前个人 Owner | 源团队 `admin`                                      | 任意 active 用户                  | 操作者为 `publisher/admin` 的 active 团队 | 预检 `403 SITE_ADMIN_REQUIRED`；持锁后失权为 `404 SITE_NOT_FOUND`     |
| Admin Console                                  | platform admin | platform admin                                      | 任意 active 用户                  | 当前环境任意 active 团队                  | `403 PLATFORM_ADMIN_REQUIRED`；持锁后失权为 `404 SITE_NOT_FOUND`      |
| Public transfer API：用户、Connection JWT、PAT | 当前个人 Owner | 源团队 `admin`                                      | 仅已认证 actor 自己，保持现有约束 | 操作者为 `publisher/admin` 的 active 团队 | 预检 `403 SITE_TRANSFER_FORBIDDEN`；持锁后失权为 `404 SITE_NOT_FOUND` |
| Public transfer API：TAT                       | 不适用         | 不允许改变 Owner；向同一团队提交也按相同 Owner 拒绝 | 不允许                            | 不允许改变为其它团队                      | `403 SITE_TRANSFER_FORBIDDEN`                                         |
| deploy 隐式转移：用户、Connection JWT、PAT     | 当前个人 Owner | 源团队 `admin`                                      | deploy 不提供个人目标             | 操作者为 `publisher/admin` 的 active 团队 | 预检 `403 DEPLOY_FORBIDDEN`；持锁后失权沿用 `404 SITE_NOT_FOUND`      |
| deploy：TAT                                    | 不适用         | 可以继续部署自身团队站点，但不能改变 Owner          | 不支持                            | 不允许改变为其它团队                      | `403 DEPLOY_FORBIDDEN`                                                |

Public API 现有“转个人仅允许转给已认证 actor 自己”的限制保持不变；本次只保留 Console Owner 对其他 active 用户的直接转移体验，不扩大非交互凭证权限。因为源团队从 `publisher/admin` 收紧为 `admin` 是公开行为变更，OpenAPI、CLI/skill 提示和相关 contract tests 都是必改项，而不是可选同步项。

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
- Workspace 团队候选仅显示操作者具备 `publisher` / `admin` 权限的 active 团队；Admin Console 继续显示当前环境内所有 active 团队，不受管理员的团队成员身份限制。
- 当前 Owner 不作为可提交目标；未选择目标或选择相同目标时“继续”按钮禁用。
- 点击“继续”后打开共享 `ConfirmDialog`。提交使用打开确认框时冻结的目标 id/type，避免搜索或异步列表刷新改变提交对象。

确认框展示：

- 标题：“确认转移站点归属”。
- 摘要：“当前归属 → 目标归属”。
- 固定说明：“转移会立即改变站点资产归属和管理权限。”
- 根据当前入口、目标类型和操作者在目标团队的角色判断：若转移后操作者将失权，额外提示“转移成功后，你将无法继续访问或管理此站点。”
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

## 确认模型

Owner 转移只要求有效 Console session、服务端权限校验和一次明确的二次确认，不要求最近 15 分钟内重新经过 SSO，也不引入 `reauth=1`、`X-Console-Auth-Time` 或 `CONSOLE_RECENT_LOGIN_REQUIRED`。

二次确认是防误操作机制，不是新的身份认证因子。确认框必须完整展示当前归属、目标归属和可能失去访问权的后果；只有用户点击“确认转移”后才发送请求。浏览器不能绕过服务端的源 Owner、团队角色、目标状态、commit lease、审计和 route snapshot 约束。

该取舍降低操作和跨 Worker 发布复杂度，但意味着已持有有效 Console session 的人可以在满足业务权限时完成转移。现有 host-only、HttpOnly、SameSite Console cookie、CSRF 校验、公司网络门禁和服务端授权继续承担会话保护职责。

## 服务端授权与一致性

沿用现有 `createTransferSiteOwner`、site commit lease、owner/route expected tuple、route snapshot 刷新和失败补偿，不另建第二套转移逻辑。

共享 application 在锁内重新读取 actor、站点、源 Owner、目标 Owner 和 route 后执行：

1. 校验源站点转移权限：个人 Owner 本人，或源团队 `admin`；platform admin bypass。
2. 校验目标用户/团队仍然 active，并重新检查目标团队成员角色。
3. 拒绝与当前 Owner 相同的目标。
4. 校验团队目标与当前 visibility 兼容。
5. 原子更新 Owner、相关 `site_members`、route `policyVersion` 与 `site.owner.transfer` 审计事件。
6. 刷新 active route snapshot；失败沿用现有补偿并返回 repair-required 错误。

为了关闭权限检查与提交之间的竞态，所有可变授权条件都必须在 site commit lease 内重新读取，并由同一次 D1 事务的 guarded statement 约束，不能只在 handler 或 UI 中判断。约束至少包括源 Owner tuple、源个人 Owner / 团队 `admin` / platform admin 权限、目标用户或团队的 active 与环境状态，以及目标团队的 `publisher` / `admin` 成员角色。任一 guard 未命中都必须零副作用失败。

失败语义保持现有 ownership application 边界，不在本次重做跨 D1/KV 事务模型：

- 源权限、目标、相同 Owner、visibility 或 lease 校验在首次提交前失败时，不修改 Owner、`policyVersion`、snapshot 或审计。
- D1 已提交但 snapshot 刷新失败，且补偿成功时，Owner 恢复为原值；补偿会再次推进 `policyVersion`，首次 `site.owner.transfer` 审计仍作为一次已提交后被补偿的尝试保留。API 返回 `503 ROUTE_POLICY_REPAIR_REQUIRED`，不得显示转移成功。
- 补偿或恢复后的 snapshot 仍失败时，清理当前 route pointer 并返回 `503 ROUTE_POLICY_REPAIR_REQUIRED` 以 fail closed；此时不得承诺 Owner、`policyVersion` 或审计完全回到请求前状态，需要由现有修复流程恢复并通过详情/审计确认。

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

| code                           | status | UI 行为                                          |
| ------------------------------ | -----: | ------------------------------------------------ |
| `SITE_ADMIN_REQUIRED`          |    403 | Workspace 提示仅个人 Owner 或源团队 admin 可转移 |
| `SITE_TRANSFER_INVALID`        |    400 | 提示目标无效或与当前归属相同                     |
| `SITE_TRANSFER_FORBIDDEN`      |    403 | 提示目标用户/团队不可用或无目标团队权限          |
| `SITE_VISIBILITY_INVALID`      |    400 | 提示先把 `owner` visibility 改为团队支持的模式   |
| `SITE_POLICY_CONFLICT`         |    409 | 提示站点或权限已变化，刷新后重试                 |
| `ROUTE_POLICY_REPAIR_REQUIRED` |    503 | 提示归属未能安全生效，刷新确认后重试             |

不存在或在持锁复核时失权继续返回 `SITE_NOT_FOUND`，避免泄露站点归属。错误响应、日志和 UI 不包含 session、token 或内部 provider 信息。

## 测试

### pages-console Worker

- 有效的 host-bound Console session 可以提交 Owner 转移，不要求 `authTime`。
- BFF 继续重建内部身份请求头，忽略浏览器伪造的 `X-Console-*`。

### pages-api

- `canTransferOwnership` 对个人 Owner、团队 admin、团队 publisher/viewer 和 platform admin 的投影正确。
- 团队 publisher 不能转移；团队 admin 可以。
- admin 在获取 lease 后被降为 publisher时，转移失败且不写 Owner、audit 或 snapshot。
- 获取 lease 后目标用户或团队变为非 active 时，转移失败且不写 Owner、policy、audit 或 snapshot。
- 获取 lease 后操作者失去目标团队 `publisher` / `admin` 角色时，转移失败且不写 Owner、policy、audit 或 snapshot。
- inactive 用户、无权限目标团队、相同 Owner、owner visibility 转团队继续 fail closed。
- Public API 和 deploy 路径无法绕过源团队 admin 规则；原有目标限制保持不变。
- 成功路径中 Owner、`site_members`、`policyVersion`、audit 与 active route snapshot 保持一致。
- 首次 snapshot 写入失败但补偿成功时，恢复旧 Owner、再次推进 `policyVersion`、保留首次 transfer audit，并返回 `503 ROUTE_POLICY_REPAIR_REQUIRED`。
- 补偿或恢复 snapshot 再次失败时，清理 route pointer 并返回 `503 ROUTE_POLICY_REPAIR_REQUIRED`；测试不得断言 Owner、policy 或 audit 已完全回到请求前状态。

### UI

- 设置页不再重复显示旧卡片中的 Slug、Hostname 或站点标题。
- 无 `canTransferOwnership` 时不显示转移入口。
- 目标为空或与当前 Owner 相同时不能继续。
- 只有点击确认后才发送一次 PATCH；请求中不可重复提交或关闭弹窗。
- API 错误留在确认框，不出现重新验证身份入口。
- 转给其他个人后 replace 导航；仍有权限时只 patch Owner/permissions 并保留并发 metadata。
- 站点切换或组件卸载后，迟到响应不能写入新页面。
- 共享 Dialog 继续保持滚动位置和焦点恢复，避免设置页面跳动。

## 公开 API 与文档同步

- 更新 `docs/architecture/xd-cell-console.md`：删除“publisher 可转移归属”，说明独立归属卡片和 team admin 权限。
- 更新 `docs/architecture/publishing-and-runtime.md`、`docs/architecture/data-model.md` 和 `docs/api-boundary.md`：删除 Owner 转移的 recent-login 要求及重认证链路。
- 必须同步 `apps/pages-api/src/openapi.js`、`docs/api-boundary.md`、CLI/skill 文案和契约测试，明确 Public transfer 与 deploy 的源团队 `admin` 限制、TAT 限制及错误码；不公开 `/openapi.json`。

## 验收标准

- 页面中名称、URL、Owner 各只有一个明确入口。
- 个人当前 Owner 可直接转给另一 active 用户或可管理团队。
- 团队 publisher 不能通过 UI、Console BFF、Public transfer API 或 deploy 路径转移团队站点；团队 admin 可以。
- 有效 Console session 在通过源权限和目标校验后，可通过二次确认完成转移；流程不要求重新验证身份。
- 首次提交前失败不会产生 Owner、policy、snapshot 或审计变化；首次提交后的 snapshot/补偿失败严格遵循上文 fail-closed 语义，UI 不误报成功。
- 转移导致操作者失权时，页面不会继续展示不可访问站点的详情。
- focused tests、`pnpm lint` 和 `pnpm test` 全部通过。
