# XD Cell Console 权限、团队与数据模型设计

本文是 [XD Cell Console 产品与架构讨论稿](2026-06-30-xd-cell-console-product-design.md) 的配套文档，集中描述团队组织模型、XDS / OA 接入、权限计算、Access Key 生命周期和逻辑表结构。

## 团队与组织模型

参考 `2026-06-23-pages-user-team-system-research.md`，XD Cell 应把团队作为资产归属和协作的核心抽象。

核心原则：

- 不自建账号密码系统，登录身份来自公司 SSO。
- XD Cell 自己维护用户、团队、团队成员、资产归属、角色权限、access key 和审计日志。
- 资产 owner 只有两类：`user` 或 `team`。
- 部门不是第三种 owner；部门团队是 `teamType = "department"` 的 team。
- 资产绑定 XD Cell 内部稳定 `team.id`，不绑定部门名称。
- 用户通过团队成员身份获得团队资产的查看、编辑或管理能力。

建议模型：

```ts
interface User {
  id: string;
  email: string;
  name: string | null;
  employeeStatus: "active" | "disabled" | "left" | "unknown";
}

interface Team {
  id: string;
  name: string;
  description: string | null;
  teamType: "custom" | "department";
  status: "active" | "merged";
  createdByType: "user" | "system" | "platform_admin";
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

interface TeamMember {
  teamId: string;
  userId: string;
  role: "viewer" | "publisher" | "admin";
  createdAt: string;
  updatedAt: string;
}

interface AssetOwner {
  ownerType: "user" | "team";
  ownerId: string;
}
```

角色：

| role | 中文 | 能力 |
| --- | --- | --- |
| `viewer` | 只读 | 查看团队站点、部署记录和基础配置 |
| `publisher` | 可发布 | 通过 CLI / CI / AI / agent 等受控入口创建团队站点、创建或更新 deployment、查看部署记录、修改低风险配置 |
| `admin` | 管理 | 管理成员、设置角色、删除或转移资产、管理团队 access key |

`publisher` 是发布权限，不等同于控制台网页上传发布。第一版不支持从控制台上传并发布站点；发布仍通过 CLI / CI / AI / agent 等受控入口完成。团队 `publisher` 可以通过受控入口创建 team-owned site。`publisher` 不允许修改访问策略、管理 secrets、创建 team access key、删除站点或转移资产。非敏感 Vars、展示偏好等低风险配置可以由 `publisher` 管理；高风险配置统一要求 `admin`。

## 部门团队

部门团队创建和加入流程：

1. 用户完成 SSO 登录。
2. XD Cell 根据用户邮箱查询 OA / XDS 用户信息，获取部门路径。
3. 如果没有对应 active `department` team，则系统创建部门团队。
4. 用户自动加入部门团队。
5. 用户初次关联部门团队时，默认角色为 `admin`。
6. 部门用户可以自行管理该部门团队内的权限变更。
7. 平台管理员可以后续介入设置 team admin、合并部门团队或转移资产。

部门团队自动成员初次加入默认 `admin` 是已确认策略。Console UI 必须醒目标识 `department_auto` 成员来源，并提示部门团队可以后续自行调整成员角色；成员移除、角色降低、资产转移和团队合并必须要求明确确认并写审计。

自动成员同步规则：

- XDS hydration 只负责发现用户当前部门路径和首次建立自动部门成员关系。
- 如果成员角色被团队 admin 或平台管理员手动修改，后续 hydration 不得把角色覆盖回默认 `admin`。
- 如果自动部门成员被团队 admin 或平台管理员移除，系统必须记录移除覆盖；只要用户仍处于同一部门路径，后续 hydration 不自动加回。
- 如果用户部门路径变化，新部门团队按首次关联规则处理。旧部门团队的移除覆盖默认保留；如果用户未来又回到同一个部门路径，系统不自动恢复已被移除的成员关系，必须由团队 admin 或平台管理员手动恢复。

部门路径变化立即生效：

- 如果用户转岗，下一次 SSO / XDS hydration 确认新部门路径后，用户关系立即迁移。
- 用户会加入新部门团队，并从旧部门团队移除自动部门 membership。
- 如果用户在旧部门团队还有人工授予的额外身份，第一版仍以“部门路径事实”为准立即移除；后续如需保留跨部门协作，应通过 `custom` 团队承载。
- 迁移必须写入审计日志，记录 oldDepartmentPath、newDepartmentPath、oldTeamId、newTeamId 和 actor=`system`。

部门路径变化不自动判断为部门改名。因为 XDS 当前只返回部门路径，没有稳定部门 ID，平台无法可靠区分：

- 原部门改名。
- 新部门。
- 组织拆分或合并。
- XDS 字段格式变化。

因此：

- 新部门路径找不到现有 department team 时，创建新部门团队。
- 旧部门团队和资产保留。
- 平台管理员必须具备“合并部门团队”能力，用于处理部门改名、组织合并或误创建。
- 合并操作必须迁移资产、合并成员、将 source team 标记为 `merged`，并写审计日志。
- 如果 XDS 后续返回稳定部门 ID，XD Cell 可以增加外部组织映射表，但资产 owner 仍绑定内部 `team.id`。

## XDS / OA 部门信息接入

接口形式：

```bash
TS=$(date +%s)
NONCE=$(uuidgen | tr 'A-Z' 'a-z')
KEY="$XDS_OPENAI_TOKEN"
SIGN=$(printf "%s%s%s" "$TS" "$NONCE" "$KEY" | shasum -a 1 | awk '{print $1}')
curl -X POST 'https://xds.xindong.com/xds-open-api/v1/oa-user/list-by-email' \
  -H 'Content-Type: application/json' \
  -H "x-ts: $TS" \
  -H "x-nonce: $NONCE" \
  -H "x-sign: $SIGN" \
  -d '{"emails":["user@example.test"]}'
```

安全规则：

- `XDS_OPENAI_TOKEN` 只能来自 Worker secret、GitHub Actions secret 或本地 ignored env。
- 不得把 token 明文写入 Git、日志、文档、测试快照或聊天记录。
- 请求签名和响应日志必须脱敏。
- 本地或 CI 测试只总结字段结构，不输出完整个人资料。

已验证响应结构：

```ts
interface XdsListByEmailResponse {
  code: number;
  message: string;
  data: {
    items: Array<{
      userId: string;
      name: string;
      email: string;
      department: string; // 部门路径，例如 心动/发行服务/平台支撑部/技术/Web
      position?: string;
      userType?: string;
      status?: string;
      found: boolean;
      outSource?: boolean;
    }>;
  };
  timestamp: number;
}
```

建议归一化输出：

```ts
interface OrgDirectoryUser {
  email: string;
  userId?: string;
  name?: string;
  employeeStatus?: "active" | "disabled" | "left" | "unknown";
  departmentPath: string | null; // from XDS item.department
}
```

登录链路建议：

- `pages-auth` 完成 SSO profile upsert 后触发 org directory hydration。
- hydration 成功时同步部门团队成员关系。
- 如果 departmentPath 变化，立即执行部门团队 membership 迁移。
- hydration 失败不应让 SSO 登录整体失败，但应记录可排查的非敏感错误，并让 console 展示“部门团队信息暂不可用”。
- 对访问控制依赖部门路径的 ACL，若无法确认部门信息，应 fail closed。

## 权限设计

权限围绕三类对象：

- User：SSO 用户。
- Team：自建团队或部门团队。
- Site：归属于 user 或 team 的资产。

角色矩阵：

| role | 查看站点 | 创建团队站点 | 发布 / 部署 | 修改低风险配置 | 修改访问策略 / secrets | 管理成员 | 创建 team access key | 删除 / 转移资产 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| viewer | 是 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| publisher | 是 | 是 | 是 | 是 | 否 | 否 | 否 | 否 |
| admin | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 |

个人 owner 等价于个人资产 admin。平台管理员不自动成为所有资产 owner，但可通过 admin API 执行治理动作，且必须写审计。

有效权限计算：

```text
effectivePermission(user, site) =
  platform_admin override for admin-api only
  OR owner_type=user and owner_id=user.id -> admin
  OR owner_type=team and max(team_members.role where team owns site)
```

第一版不新增面向用户的 `site_members` / 站点协作者模型，避免和团队成员、ACL 内容访问混在一起。站点管理权限只来自个人 owner 或 owner team 角色；如果后续需要站点级协作，应单独设计菜单、角色和审计规则。

内容访问权限和管理权限分开：

- 内容访问由 `pages-router` 根据 visibility / site_session / ACL / owner 判定。
- 管理权限由 `pages-api` / `pages-console` 根据 owner 和 team role 判定。
- 一个用户能访问站点内容，不代表能管理站点。

部门团队权限：

- 第一版部门团队自动成员初次加入默认 `admin`，因此部门内用户可以自行管理该部门团队的权限变更。
- UI 必须醒目标识 `membership_source=department_auto` 的成员来源，并提示部门团队可以后续自行调整成员角色。
- 手动修改后的角色或移除覆盖优先于默认自动角色；后续 XDS hydration 不得把成员自动刷回 `admin`。
- 成员移除、角色降低、资产转移、团队合并必须写审计。
- 部门团队 admin 可以管理 team access key，但 key scope 仍受团队资产范围限制。
- 平台管理员可以合并部门团队，处理部门路径变化造成的多个部门团队。

## Access Key 权限

Access Key 的能力由 owner、site 限定和 scopes 共同决定：

```text
commonAllowed =
  key not revoked
  AND key not expired
  AND key environment matches request environment
  AND requested scope in key.scopes
  AND requested site is within key owner/site boundary

userOwnedAllowed =
  commonAllowed
  AND owner user still active
  AND owner user still has required management permission on requested target

teamOwnedAllowed =
  commonAllowed
  AND owner team still active
```

规则：

- user-owned key 每次使用都必须重新计算创建用户当前权限；用户离职、禁用、退出团队或失去站点管理权限后，key 不能继续借旧权限操作。
- team-owned key 归属于团队，创建者离开团队后 key 不会因为创建者身份变化自动失效，但团队不再 active、key 到期或撤销后必须失效。
- 默认有效期 3 个月；创建时可以设置更短或更长的有效期，但最长有效期为 1 年。
- 第一版不提供全平台 deploy key；deploy-capable key 必须限定 user / team owner 范围或单站点范围。
- staging access key 不能调用 production API，production key 也不能调用 staging API。

## 安全边界

- `pages-console` Worker 所有页面、静态资源和 `/api/console/*` BFF API 都必须先经过公司网络、VPN 或办公网 IP allowlist；未通过时直接 403，不读取 cookie、不重定向、不调用 `pages-api` / `pages-auth` service binding。
- `workers.xd.team` 首页未登录只在 console IP allowlist 内展示 internal 站点和产品信息，不泄露 protected 站点 metadata。
- `/workspace/*` 在 IP allowlist 后仍必须登录。
- `/admin/*` 在 IP allowlist 后仍必须平台管理员。
- `staging.workers.xd.team/*` 在 IP allowlist 后仍必须平台管理员；auth login/callback 只豁免 session / admin gate，不豁免 IP allowlist。
- console BFF 所有写请求必须做 CSRF / Origin / Referer 校验。
- Secret value 永不返回浏览器。
- Access key plaintext 只在创建响应中显示一次。
- 部门 ACL 无法确认用户部门时 fail closed。
- staging / production session、API、D1、KV、DO、WFP namespace、signing key 必须隔离。
- production 不因 push/PR 自动部署。
- v2 console 不信任 v1 `X-Pages-Token` / `PAGES_TOKEN` 作为认证或归属来源；所有管理权限都必须来自 v2 session、owner、team role 或 access key。
- 审计导出必须脱敏 metadata，不导出 secret value、access key hash / plaintext、cookie、session、XDS token、Cloudflare API token 或 provider resource id。

## 表结构设计

本文只给逻辑表结构，字段类型和迁移细节在 implementation plan 中细化。所有表都应包含 `environment`，production 和 staging 物理资源隔离；下文省略部分审计字段时，默认仍需要 `created_at` / `updated_at` / `created_by`。

### users

现有 `users` 表继续作为 SSO 用户权威缓存，建议补充部门路径缓存字段：

```sql
users
  user_id
  email
  realname
  employee_status
  department_path
  department_checked_at
  session_version
  last_login_at
```

`department_path` 是 XDS 当前返回的部门路径缓存，不是稳定主键。权限判断不能只信任过期缓存；受保护操作需要满足 freshness。

### platform_admins

平台管理员是独立授权，不应混在普通 `users` 字段里。建议增加逻辑表：

```sql
platform_admins
  environment
  user_id
  granted_by_user_id
  grant_reason
  revoked_at
  revoked_by_user_id
  revoke_reason
  created_at
  updated_at
```

规则：

- production 和 staging 平台管理员授权必须按环境隔离。
- 设置或取消平台管理员必须写审计日志。
- 平台管理员不自动成为所有资产 owner；只能通过 admin lane 执行治理动作。

### teams

```sql
teams
  id                  -- team_xxx
  environment
  name
  description
  team_type           -- custom / department
  department_path     -- team_type=department 时保存当前匹配路径
  status              -- active / merged
  created_by_type     -- user / system / platform_admin
  created_by_user_id
  merged_into_team_id
  merged_at
  created_at
  updated_at
```

约束建议：

- `unique(environment, team_type, department_path)` where `team_type = department and status = active`。
- `department_path` 可变更，但不能作为资产 owner；资产 owner 永远绑定 `teams.id`。
- 自建团队删除前必须完成资产盘点和处置；仍拥有站点或有效 team-owned Access Key 的团队不得删除。
- `merged` 只用于部门团队合并后的 source team，不等同于普通自建团队软删除。

### team_members

```sql
team_members
  team_id
  user_id
  role                -- viewer / publisher / admin
  membership_source   -- manual / department_auto / platform_admin
  department_path     -- membership_source=department_auto 时记录来源路径
  role_overridden_at  -- 手动调整部门自动成员角色时记录
  removed_at          -- 手动移除成员时记录；不物理删除，避免 hydration 自动加回
  removed_by_user_id
  restored_at         -- 手动恢复已移除成员时记录
  restored_by_user_id
  created_at
  updated_at
```

规则：

- `(team_id, user_id)` 唯一；权限计算只使用 `removed_at is null` 的成员关系。
- 用户转岗后，系统结束旧部门团队中 `membership_source=department_auto` 的有效成员关系，并加入新部门团队。
- 第一版部门团队初次自动加入角色为 `admin`。
- 团队 admin 或平台管理员手动调整 `department_auto` 成员角色后，设置 `role_overridden_at`；后续 hydration 只更新部门状态，不覆盖手动角色。
- 团队 admin 或平台管理员移除 `department_auto` 成员后，设置 `removed_at` 和 `removed_by_user_id`；只要用户仍处于相同 `department_path`，后续 hydration 不自动恢复该成员关系。
- 如果用户离开部门后又回到同一个部门路径，已有 `removed_at` 仍然生效，系统不自动恢复成员关系；恢复必须由团队 admin 或平台管理员显式执行，并设置 `restored_at` / `restored_by_user_id`、清空 `removed_at`。
- 自建团队成员关系由团队 admin 或平台管理员维护。

### site owner

现有 `sites.owner_user_id` 只覆盖个人 owner。为了支持团队资产，建议迁移为通用 owner：

```sql
sites
  id
  environment
  slug
  owner_type          -- user / team
  owner_id            -- user_id or team_id
  owner_user_id       -- 兼容旧字段，迁移期保留
  default_visibility
  site_uuid
  deleted_at
```

迁移策略：

- 旧个人站点：`owner_type=user`，`owner_id=owner_user_id`。
- 团队站点：`owner_type=team`，`owner_id=teams.id`。
- 第一版不新增 `site_members` 站点级协作者；站点管理权限来自 owner user 或 owner team。未来如果需要站点级协作，需要单独增加表结构、菜单、角色和审计。

### access_keys

现有 access key 表建议扩展 owner 模型：

```sql
access_keys
  id
  environment
  owner_type          -- user / team
  owner_id            -- user_id or team_id
  created_by_user_id
  key_hash
  pepper_id
  name
  scopes_json
  site_id             -- null 表示 owner scope；非 null 表示限定站点
  expires_at          -- 创建时必填，默认 3 个月，最长 1 年
  last_used_at
  revoked_at
  revoked_by_user_id
  revoked_reason
  created_at
```

规则：

- user-owned key 由用户创建，每次使用时权限不超过该用户当下有效权限。
- team-owned key 由 team admin 创建，权限不超过团队 owner 权限；创建者后续离开团队不自动影响 key，但 team 不再 active、key 到期或撤销后必须失效。
- deploy-capable key 必须限定 owner 范围或 site 范围，不能默认为全平台。
- owner-scope team key 可以作用于该团队当前和未来创建的团队站点；site-scoped key 只作用于指定站点。
- 创建时默认有效期 3 个月，最长有效期 1 年。
- plaintext 只显示一次。

### webhook_subscriptions

Admin Webhook 是平台级出站订阅。第一版只允许平台管理员创建和管理，不开放普通用户或团队自助订阅。

```sql
webhook_subscriptions
  id
  environment
  name
  url_secret_ref        -- 指向加密密文或受控 secret 存储引用
  url_host
  url_fingerprint      -- 用于变更检测和审计，不可还原完整 URL
  events_json
  payload_mode         -- standard / template
  template_json        -- payload_mode=template 时保存受限 JSON 模板
  template_revision
  enabled
  last_delivery_status
  last_delivered_at
  created_by_user_id
  created_at
  updated_at
```

规则：

- Webhook URL 创建、编辑和每次投递前都必须执行 SSRF 校验；只允许 `https://`，阻止内网地址、localhost、link-local 和 metadata endpoint。
- 第一版禁止 HTTP redirect；后续如允许 redirect，每一跳 target 都必须重新执行 SSRF 校验。
- 第一版不额外提供 signing secret 或 HMAC 签名，Webhook URL 本身按 bearer secret 处理。
- 平台需要使用完整 Webhook URL 发起投递，因此不能只保存不可逆 hash。实现上应保存加密密文或受控 secret 存储引用；列表、详情、日志和审计导出只能展示 host 和脱敏后的尾部字符。
- 投递请求必须带 `X-XD-Cell-Event`、`X-XD-Cell-Delivery`、`X-XD-Cell-Timestamp`，用于接收方识别事件和做幂等；这些 header 不作为强身份认证。
- 订阅事件第一版限制为产品文档列出的 allowlist，不能让管理员输入任意 event type。
- 默认 `payload_mode=standard`，直接投递 XD Cell 标准 payload。
- `payload_mode=template` 时，模板输入只能是脱敏后的标准 payload；模板只能使用白名单变量替换，不支持 JS、任意表达式、网络请求、数据库访问或内部未脱敏字段。
- 模板保存前必须校验输出为合法 JSON，并记录 `template_revision`；投递记录必须保存使用的模板 revision。

### webhook_deliveries

Webhook 投递记录用于 admin 查询、重试和审计，不保存完整 payload。

```sql
webhook_deliveries
  id
  environment
  subscription_id
  event_type
  event_id
  delivery_status      -- pending / delivered / retrying / failed / skipped
  attempt_count
  last_http_status
  next_retry_at
  delivered_at
  target_url_host
  payload_hash
  payload_mode
  template_revision
  render_status        -- not_used / rendered / render_failed
  error_summary        -- 脱敏摘要
  created_at
  updated_at
```

规则：

- delivery id 必须稳定，用于接收方幂等和平台重试。
- retry 使用有限次数和退避策略；终态 failed 后不再自动无限重试。
- `payload_hash` 可用于排查和幂等，但不得保存完整标准 payload、渲染后 payload、完整 Webhook URL、token、cookie 或敏感 metadata。
- 模板渲染失败时，delivery 标记为 `failed` 或 `skipped`，记录脱敏失败摘要，不向目标 URL 投递无效 payload。
- 手动重试必须写审计日志，并复用相同 delivery id 或记录 parent delivery id，避免接收方无法判断幂等关系。

### audit_events

现有 `audit_events` 继续扩展用于团队和目录事件：

```sql
audit_events
  id
  environment
  event_type
  actor_user_id
  actor_type          -- user / access_key / system / platform_admin
  target_type         -- site / team / user / access_key / route / hostname_claim
  target_id
  site_id
  team_id
  decision
  request_id
  ip_hash
  user_agent_hash
  metadata_json       -- 脱敏
  created_at
```

必须审计：

- 部门团队自动创建。
- 用户部门团队迁移。
- 团队成员角色变更。
- 部门团队合并。
- 资产转移。
- access key 创建 / 撤销。
- webhook subscription 创建 / 编辑 / 禁用 / 删除。
- webhook delivery 手动重试。
- platform admin 授权 / 取消授权。
- visibility / ACL / secret name 变更。

审计 metadata 只保存可排查的安全摘要。禁止保存 secret value、access key plaintext / hash、cookie、session、XDS token、Cloudflare API token、完整 Webhook URL、完整 webhook 敏感 payload 或可直接调用 provider 的内部资源凭证。
