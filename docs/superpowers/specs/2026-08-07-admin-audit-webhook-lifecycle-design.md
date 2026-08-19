# Admin 审计可读性与站点生命周期 Webhook 设计

## 背景

XD Cell Console 管理后台目前有两组相邻问题：

- 审计日志直接展示英文 `eventType`，管理员需要理解内部枚举才能判断事件含义。
- 审计摘要只识别少量 metadata key，命中时最多展示两个字段，未命中时退化为“X 个字段”，且页面没有详情入口。
- Admin Webhook 的 UI 和 pages-api allowlist 都只支持 `site.deployed`，唯一生产者也是成功部署路径。

2026-07-03 的 Console 调整把常驻 JSON metadata 改成了摘要，改善了列表扫描性，但同时移除了查看完整信息的入口。之后新增的 connection、资源治理和 v1 退役审计事件使用了更多 metadata 结构，使“X 个字段”的退化更常见。

Webhook 事件范围曾出现过没有真实生产者的 UI 占位项，随后被收紧为 `site.deployed`。本次扩展必须继续遵守“只有 pages-api 真实产生并投递的事件才能开放订阅”的约束，不能只增加前端复选框或扩大 API allowlist。

## 目标

1. 审计日志以中文展示已知事件，同时保留稳定的英文技术枚举。
2. 审计列表提供可扫描的事件摘要，并允许管理员查看完整、脱敏后的事件详情。
3. Webhook 在保留 `site.deployed` 的基础上增加：
   - `site.failed`：部署或回滚失败。
   - `site.disabled`：站点访问策略成功切换为 `disabled`。
   - `site.deleted`：站点成功删除。
4. Webhook 事件清单由 pages-api 维护单一真相源，Console 不再独立硬编码可订阅事件。
5. 新事件遵守现有 URL 加密、SSRF 防护、Payload 脱敏、受限模板和 best-effort 投递边界。

## 非目标

- 不把 `audit_events` 直接转换成通用 Webhook 事件流。
- 不增加站点创建、重新启用、Owner 转移、团队成员、Access Key、Secret 或管理员治理 Webhook。platform-admin 的 force DELETE 仍属于 `site.deleted` 生命周期事件生产者，不新增独立的管理员治理事件。现有 deploy owner-transfer 只作为既有部署路径中的一个事件来源，不在本设计中重新定义其状态机。
- 不增加普通用户或团队自助 Webhook。
- 不增加签名 Secret、HMAC、持久化 outbox、严格 exactly-once、自动重试执行器或手动重试 API。
- 不修改数据库 schema、公开 OpenAPI、CLI help、pages skill 或 v1 legacy API。
- 不修复与本需求无关的审计分页、服务端筛选或站点删除流程问题。

## 方案比较

### 方案 A：显式事件目录与业务生产者

pages-api 维护唯一事件目录；每个业务操作在状态成功提交后显式调用投递 helper；Console 从管理 API 读取目录。

优点：

- 可订阅项和真实生产者一一对应。
- 每类事件可以定义独立的安全 Payload 和触发时机。
- 不会把审计 metadata 意外扩大为外部协议。

缺点：

- 每增加一个事件，都需要实现生产者、Payload、测试和文档。

### 方案 B：前后端继续维护两份常量

Console 和 pages-api 分别增加相同事件常量，业务路径补充投递调用。

优点是改动较少；缺点是事件名称、说明和模板字段容易漂移，重复当前问题。

### 方案 C：审计流统一转发 Webhook

所有或部分 `audit_events` 写入后自动转换为 Webhook。

该方案扩展速度快，但审计与集成协议的安全边界、事务时机和事件语义不同。它还会把本次站点生命周期需求扩展成通用事件总线，因此不采用。

## 选定方案

采用方案 A。审计展示仍消费管理 API 返回的审计事件；Webhook 使用独立、显式的事件目录和业务生产者。两者可以共享中文用语，但不共享数据流或自动转换逻辑。

## 审计日志设计

### 稳定枚举与中文展示

数据库和 API 中的 `eventType` 保持英文稳定枚举。`apps/pages-console/src/ui/admin-audit-model.js` 增加审计事件展示目录，至少覆盖当前生产写入器产生的事件：

- `admin.platform_admin.grant`：授予平台管理员。
- `admin.platform_admin.revoke`：撤销平台管理员。
- `admin.department_team.merge`：合并部门团队。
- `system.department_team.create`：创建部门团队。
- `system.department_membership.join`：同步部门团队成员。
- `system.department_membership.migrate`：迁移部门团队成员。
- `team.delete`：删除团队。
- `site_secret.put`：更新站点 Secret。
- `site_secret.delete`：删除站点 Secret。
- `site.owner.transfer`：转移站点归属。
- `site.v1_takeover`：接管 v1 同名站点。
- `connection.user.link`：连接已有用户。
- `connection.user.create`：通过连接创建用户。
- `connection.request.deny`：拒绝连接请求。
- `admin.v1_site_retire`：退役 v1 站点。
- `admin.cleanup_run_due`：批量执行到期清理。
- `admin.worker_orphan_backfill`：回填孤儿 Worker 清理任务。
- `admin.cleanup_run`：执行部署资源清理。

列表主标题显示中文名称，次级文本保留原始 `eventType`。未知事件不伪造翻译，直接用原始枚举作为主标题，并继续支持查看详情。

### 事件感知摘要

摘要 helper 接收完整 event，而不是只接收 metadata。已知事件使用事件专属格式，展示 2–3 个最有助于识别对象和结果的事实，例如：

- 站点归属转移：`demo：个人 usr_1 → 团队 team_1`。
- 团队合并：`team_a → team_b；站点 2 / Access Key 1 / 成员 5`。
- 到期清理：`处理 4；成功 3 / 失败 1 / 跳过 0`。
- v1 站点退役：`demo；阶段 KV 删除；demo.workers.xd.team`。
- 连接拒绝：`actor@example.com；原因 PAGES_USER_INACTIVE`。

未知事件从顶层资源 ID 和 metadata 中选择最多三个可安全序列化的 primitive 值。对象或数组使用有界摘要，例如字段数量、项目数量或一层关键计数；不能再只显示“X 个字段”而没有详情入口。

摘要只负责扫描，不承担完整诊断。长文本和内部 ID 使用现有截断规则。

### 详情层

每行提供“查看详情”入口，打开侧边详情层。详情包含：

- 中文事件名和原始 `eventType`。
- event id。
- 操作人名称、邮箱或 actor 类型。
- Decision、HTTP status code 和发生时间。
- `siteId`、`routeId`、`versionId`；空值不展示。
- 完整的服务端防御性脱敏 metadata，以格式化 JSON 或等价的结构化 key/value 展示。

event id 和资源 ID 提供复制操作。metadata 可以整体复制，但复制内容必须与 API 返回的防御性脱敏结果一致，不能从其它接口补充隐藏字段。

侧边详情层在 `390px`、`768px`、`1280px` 下保持可用；代码块可以在明确边界内横向滚动，页面本身不能产生非预期横向滚动。图标按钮必须有 tooltip 和 `aria-label`。

### 搜索

客户端搜索索引包含：

- 中文事件名和英文 `eventType`。
- event id、actor id、actor 类型、操作人名称和邮箱。
- Decision、status code。
- `siteId`、`routeId`、`versionId`。
- 完整脱敏 metadata 的稳定安全序列化结果。

搜索只作用于已经由 API 返回的最近 100 条事件；本次不增加服务端分页或查询参数。

### 审计 API

`apps/pages-api/src/admin.js` 的 `formatAuditEvent` 增加当前 store 已经读取但 API 丢弃的字段：

```json
{
  "siteId": "<site-id-or-null>",
  "routeId": "<route-id-or-null>",
  "versionId": "<version-id-or-null>"
}
```

`audit_events.metadata_json` 的写入器仍承担第一层安全责任：每个生产者只能写排障所需的安全摘要，不能写 Secret、token、cookie、session、完整 Webhook URL 或 provider 凭证。为了让未知和未来事件也能安全进入详情层，`formatAuditEvent` 在返回 Console 前必须再调用统一的防御性 sanitizer；本次只增加通用 denylist 和结构上限，不新增按事件类型维护的第二套 metadata 目录。

- 只接受 JSON primitive、array 和 plain object；其它值丢弃或替换为明确占位符。
- 递归处理嵌套对象，对 key 名大小写不敏感地拦截 `token`、`secret`、`password`、`authorization`、`cookie`、`session`、`ciphertext`、`privateKey`、`apiKey`、`accessKeyHash`、`accessKeyPlaintext`、`webhookUrl` 等敏感字段，并将值替换为 `[REDACTED]`。
- 无论 eventType 为何，都必须 omit 或替换 `workerName`、`resourceRef`、`providerResourceId`、`accountId`、`zoneId`、`namespaceId`、`databaseId`、`routeRef`、`cleanupResourceRef` 等 provider resource reference；这些字段不能出现在详情、搜索或整体复制结果中。
- HTTP/HTTPS URL 字符串只保留 origin/hostname 级摘要，不返回 query、fragment 或可能充当 bearer secret 的 path 尾部。
- 对递归深度、对象 key 数、数组长度和字符串长度设置固定上限；超限内容以 `[TRUNCATED]` 标识。具体上限在实现计划中按现有响应体规模选择，并通过测试锁定。
- 中文摘要、客户端搜索、详情展示和复制都只消费 sanitizer 的输出，不能继续引用原始 metadata。

保留现有 `traceId` 作为多阶段审计操作的关联字段；不返回 IP hash、user-agent hash 或新的内部 provider 信息。该变化属于 Console internal API，不修改 `apps/pages-api/src/openapi.js`。

## Webhook 事件目录

### 单一真相源

pages-api 新增聚焦的 Webhook 事件目录模块。每个事件描述至少包含：

```js
{
  type: 'site.failed',
  label: '部署失败',
  description: '站点部署或回滚进入失败终态时触发',
  requiredTemplateVariables: [
    'event.id',
    'event.type',
    'event.environment',
    'event.occurredAt',
    'site.id',
    'site.slug',
    'site.ownerType',
    'deployment.id',
    'deployment.status',
    'deployment.operation'
  ],
  optionalTemplateVariables: [
    'actor.type',
    'actor.userId',
    'actor.email',
    'actor.name',
    'site.hostname',
    'site.ownerId',
    'site.visibility',
    'site.status',
    'team.id',
    'team.name',
    'team.teamType',
    'deployment.source',
    'deployment.createdAt',
    'deployment.completedAt',
    'deployment.failureStage',
    'deployment.errorCode'
  ]
}
```

目录源码只维护互不重叠的 `requiredTemplateVariables` 和 `optionalTemplateVariables`；导出管理 API 与构建服务端全局 allowlist 时，再机械派生 `templateVariables = required ∪ optional`。required 字段必须在该事件的每个标准 Payload 中存在；optional 字段可以因为 actor 类型、owner 类型或数据可用性而在单次事件中缺失。例如 pending site creation 失败时没有 route，因此 `site.status` 对 `site.failed` 是 optional。目录测试必须断言两组无交集、派生并集完整且每个 producer Payload 满足 required invariant。

`site.deployed` 必须完整保留当前 `ALLOWED_VARIABLE_PATHS` 中已有的 event、actor、site、team 和 deployment 字段；事件目录上线不能使任何现有合法模板变成变量非法。新增事件只能在此基础上增加安全字段，不能借机收缩旧 allowlist。

事件目录服务于：

- 创建和编辑订阅时的 allowlist 校验。
- 受限模板变量的安全全局 allowlist。
- `GET /.xd-pages/api/console/admin/webhooks` 返回的 `supportedEvents`。
- Console 的事件复选框、中文说明和事件级标准 Payload 预览。

管理 API 响应变为（示例省略了由两组变量机械派生的 `templateVariables` 数组）：

```json
{
  "webhooks": [],
  "supportedEvents": [
    {
      "type": "site.deployed",
      "label": "部署成功",
      "description": "站点部署成功并激活后触发",
      "requiredTemplateVariables": [
        "event.id",
        "event.type",
        "event.environment",
        "event.occurredAt",
        "site.id",
        "site.slug",
        "site.ownerType",
        "site.status"
      ],
      "optionalTemplateVariables": [
        "actor.type",
        "actor.userId",
        "actor.email",
        "actor.name",
        "site.hostname",
        "site.ownerId",
        "site.visibility",
        "team.id",
        "team.name",
        "team.teamType",
        "deployment.id",
        "deployment.status",
        "deployment.source",
        "deployment.operation",
        "deployment.createdAt",
        "deployment.completedAt"
      ]
    }
  ]
}
```

Console 不再用独立 `EVENT_OPTIONS` 判断可选事件。目录外的历史值可以在现有订阅列表和编辑表单中以原始枚举展示，但创建或更新请求仍拒绝加入目录外事件。

### 事件集合

保留：

- `site.deployed`：现有成功部署事件，名称、生产时机和 Payload 保持兼容。当前成功 rollback 不产生该事件，本次不扩大其语义。

新增：

- `site.failed`：持久化 deployment 首次进入 `failed` 终态。包含 `deploy` 和 `rollback` operation；Payload 中的 operation 用于区分。
- `site.disabled`：既有 access-policy 操作完成后，route visibility 从任意非 `disabled` 值变为 `disabled`；生产者包括 Console access 更新、CLI-managed sites visibility 更新，以及现有 deploy owner-transfer 部署路径。
- `site.deleted`：站点删除操作成功完成。

早期 Console 曾展示过 `site.failed` 和 `site.disabled`，因此恢复这两个枚举可以兼容可能残留的历史 subscription。`team.member.updated` 没有本次生产者，继续不支持。

## 标准 Payload

现有标准 Payload 的顶层结构继续使用 `event`、`actor`、`site`、`team`、`deployment`。新增一个受限的 `change` 对象，并扩展 deployment 的安全失败字段：

```json
{
  "deployment": {
    "failureStage": "<safe-stage>",
    "errorCode": "<safe-error-code>"
  },
  "change": {
    "field": "visibility",
    "previousValue": "org",
    "currentValue": "disabled"
  }
}
```

允许字段：

- `deployment.failureStage`。
- `deployment.errorCode`。
- `change.field`。
- `change.previousValue`。
- `change.currentValue`。

明确禁止加入标准 Payload 或模板变量：

- `errorMessage` 或原始异常文本。
- failure diagnostics、cause 对象或用户上传内容。
- Cloudflare account、zone、Worker、route、KV、D1 等 provider 资源 ID。
- Secret、token、cookie、session、完整 Webhook URL 或 URL query/path secret。
- cleanup resource ref、planned Worker name 或其它可直接操作 provider 的内部引用。

### `site.deployed`

保持现有 Payload、生产者和触发时机兼容，不删除或重命名字段。它只表示常规 deployment 成功并激活；当前成功 rollback 不投递 `site.deployed`，本次也不新增成功 rollback Webhook。事件目录只为其补充中文说明和可用模板变量描述。

### `site.failed`

Payload 包含：

- `event`。
- 可用时的 `actor`。
- 目标 `site` 安全快照。
- 失败 deployment 的 id、status、source、operation、createdAt、completedAt、failureStage 和 errorCode。
- owner 为 team 且能安全解析时的 `team` 摘要。

只有已经创建 deployment row、并成功持久化为 `failed` 的操作才产生事件。请求在创建 deployment 前被参数校验、鉴权或配额检查拒绝时不产生 `site.failed`。

### `site.disabled`

Payload 包含：

- `event` 和 `actor`。
- 更新完成后的 `site` 安全快照，其中 visibility 为 `disabled`。
- `change.field = "visibility"`。
- 原 visibility 和 `disabled`。
- owner 为 team 时的可选 `team` 摘要。

ACL-only 更新、重复保存 `disabled` 或 snapshot 失败后回滚的更新不产生事件。本次不增加 `site.enabled`。

### `site.deleted`

Payload 包含：

- `event` 和 `actor`。
- 删除流程持有的安全站点快照。
- `site.status = "deleted"`。
- owner 为 team 时的可选 `team` 摘要。

Payload 不包含已删除 Worker、route snapshot、cleanup task 或 hostname claim 的内部引用。workspace Console DELETE、platform-admin force DELETE 和 CLI-managed DELETE 都是该事件的生产者；每条路径都必须把已认证的 session/actor 传给事件构造，不生成 actorless Payload。删除后的 WFP cleanup 仍是 best-effort 维护，不影响 `site.deleted` 的协议语义。

### 事件变量目录

除 `site.failed` 外，事件目录按以下规则定义 required/optional 变量；目录源码仍只维护两组互不重叠的数组，并机械派生 `templateVariables`：

| 事件            | requiredTemplateVariables                                                                                                                                                                                   | optionalTemplateVariables                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `site.disabled` | `event.id`, `event.type`, `event.environment`, `event.occurredAt`, `actor.type`, `site.id`, `site.slug`, `site.ownerType`, `site.visibility`, `change.field`, `change.previousValue`, `change.currentValue` | `actor.userId`, `actor.email`, `actor.name`, `site.hostname`, `site.ownerId`, `site.status`, `team.id`, `team.name`, `team.teamType`     |
| `site.deleted`  | `event.id`, `event.type`, `event.environment`, `event.occurredAt`, `actor.type`, `site.id`, `site.slug`, `site.ownerType`, `site.status`                                                                    | `actor.userId`, `actor.email`, `actor.name`, `site.hostname`, `site.ownerId`, `site.visibility`, `team.id`, `team.name`, `team.teamType` |

`change.*` 是本次新增的三个安全模板路径，只用于 `site.disabled`；其它事件不能使用。所有三个删除入口和三个停用入口都必须提供 required 字段，team 摘要和其它上下文字段按 optional 规则处理。

## 生产者与提交时机

### 部署失败

在现有部署和回滚失败收尾逻辑将 deployment 持久化为 `failed` 后，若该请求确实完成首次失败终态转换，则构造并投递一次 `site.failed`。幂等请求读取已失败 terminal deployment 时返回现有 failed terminal deployment envelope（当前重放语义为 HTTP 200），不重复投递，也不把首次失败的 4xx/5xx 响应重新返回。

不在本设计中新增 deployment 状态机、terminal CAS 或 reconcile 机制；沿用现有实现的终态和幂等语义。若失败状态无法持久化，则不产生 `site.failed`。

### 站点停用

Console access 更新、CLI-managed sites visibility 更新和现有 deploy owner-transfer 路径继续使用各自已有的 access-policy、route snapshot 和 route pointer 提交流程。本设计只增加事件判断：在既有业务操作确认最终 route snapshot/pointer 已成功提交后，若 visibility 从非 `disabled` 变为 `disabled`，投递一次 `site.disabled`。

ACL-only 更新、重复保存 `disabled`、snapshot/pointer 提交失败以及既有流程判定为回滚或未提交成功的操作不产生事件。Webhook 结果不能改变原有业务响应或触发额外 route 回滚。

### 站点删除

Console 删除和 CLI-managed sites API 删除继续使用现有删除、deleted route snapshot、hostname claim 和 cleanup 流程。本设计只在既有删除流程确认成功完成后投递一次 `site.deleted`；not found、重复删除、snapshot/pointer 提交失败或既有流程未确认成功时不产生事件。

### Route lifecycle 依赖边界

本设计不重新定义 D1、KV immutable snapshot、route pointer、ACL、owner-transfer、hostname claim、reconciliation 或 rollback 协议。它们沿用现有架构与实现语义：KV route pointer 是 router 可见的提交点；pointer 状态不确定时由既有业务错误和 reconciliation 机制处理。Webhook 生产者只消费业务路径已经确认的最终结果，不自行回滚或修复 route 状态。

## 投递与一致性语义

Webhook 投递继续复用：

- 加密 URL 存储。
- 创建、编辑和每次投递前的 SSRF 校验。
- HTTPS-only、禁止 redirect、阻止私网和 metadata endpoint。
- delivery metadata、Payload hash、有限的 next retry 时间计算。
- 标准 Payload 或受限 JSON 模板渲染。

事件是业务状态提交后的 best-effort 通知：

- 投递、模板渲染或 delivery 记录失败不能回滚原业务操作。
- 当前设计不使用事务 outbox，因此不承诺严格 exactly-once。
- 新生产者复用现有成功部署 Webhook 的构造、投递和异步调度模式：有 `ExecutionContext` 时使用现有 `ctx.waitUntil(promise)`，没有 `ctx` 时沿用现有 await fallback。允许从 Worker fetch 入口把可选 `ctx` 透传到 versions、sites 和 Console handler；这是既有接线扩展，不新增 delivery helper、重试器、超时协议或另一套上下文传递约定。
- 同一请求中的事件构造或投递异常继续由现有 producer 隔离；Webhook 结果不能改变原有业务响应。并发、重复请求和 pointer 状态不确定性沿用各业务路径与 route lifecycle 的既有语义。
- 接收方继续使用 `X-XD-Cell-Delivery` 做幂等，并用 `X-XD-Cell-Event` 区分事件。

## Console Webhook 体验

订阅表单从 `supportedEvents` 渲染事件选项。每项展示中文名称、原始事件枚举和触发说明。

编辑历史 subscription 时，表单把 `subscription.events` 中不在 `supportedEvents` 的值单独显示在“历史不支持事件”警告区。每个值都显示原始枚举和明确的“移除”操作；不静默丢弃，也不隐藏在表单 state 中。只要仍存在不支持事件，保存按钮保持禁用并提示必须先移除。查看、投递记录和停用 subscription 不受该限制。

标准 Payload 预览随当前选择的事件切换。根据事件目录的变量路径机械生成嵌套 placeholder 结构，避免 Console 再维护事件专属 Payload 常量。选择多个事件时提供事件切换控件，而不是把不同结构合成一个误导性示例。

新建 subscription 的默认模板改为只依赖所有站点生命周期事件都具备的字段：

```json
{
  "text": "XD Cell: {{event.type}} {{site.slug}}"
}
```

编辑已有 subscription 时不自动改写模板。模板变量校验继续执行安全全局 allowlist；Console 根据所选事件的 `requiredTemplateVariables` / `optionalTemplateVariables` 标识某变量在哪些事件中可能不存在。字符串插值缺失值变为空字符串、精确变量缺失导致 render failed 的现有语义保持不变。

## 错误处理

- 创建或更新 subscription 含目录外事件时返回现有 `WEBHOOK_EVENTS_INVALID`，action 文案根据目录动态生成。
- 目录加载失败时 Webhook 页面进入明确错误态，不能回退到过期的本地事件清单。
- 历史 subscription 含目录外事件时仍能查看和停用；编辑表单显式展示这些值并提供移除操作，在全部移除前禁止保存。
- 事件 Payload 构造只接受预定义字段，不序列化整个 site、deployment、route 或 error 对象。
- Webhook 调度异常继续被业务生产者隔离，不把完整 URL、Payload 或敏感异常写入日志和 API 响应。
- 审计未知 eventType 和未知 metadata key 必须安全展示，不能因为新事件导致整个表格或详情层渲染失败。

## 测试设计

### 审计 model

扩展 `apps/pages-console/src/ui/admin-audit-model.test.js`：

- 已知生产事件的中文映射。
- 未知事件回退原始枚举。
- owner transfer、department merge、cleanup、v1 retire、connection deny 等多字段或嵌套摘要。
- generic fallback 展示可操作信息而不是只有字段数量。
- 搜索命中中文名、英文枚举、隐藏 metadata、`siteId`、`routeId` 和 `versionId`。

### 审计 API 与 UI

- `apps/pages-api/src/admin.test.js` 断言 audit response 包含 nullable resource ids，且不新增敏感字段。
- pages-api focused 测试断言防御性 sanitizer 能递归遮盖敏感 key 和 provider resource reference、收敛完整 URL、限制异常深度/长度，并保证摘要、搜索和详情只收到 sanitizer 输出。
- Console focused 测试断言中文标题、英文次级枚举、详情入口和 metadata 详情容器存在。
- 手工验证长 ID、长 metadata 以及 `390px`、`768px`、`1280px` 布局。

### Webhook 目录与 Payload

扩展 `webhooks.test.js` 和 `webhook-payload.test.js`：

- list API 返回四个 supported events。
- 创建和更新接受四个事件，拒绝目录外事件。
- action 文案与目录一致，不再硬编码单个事件。
- 各事件标准 Payload 只包含允许字段。
- `site.failed` 包含 failureStage 和 errorCode，但不包含 errorMessage 或 diagnostics。
- `site.disabled` 包含 visibility change。
- `site.deleted` 不包含 provider 和 cleanup 引用。
- 模板预览变量目录与服务端 allowlist 一致。
- required/optional 变量目录能让 Console 对 personal site、team-owned site、pending site creation failure 和无 actor 的事件显示准确的可能缺失字段告警；目录测试断言两组无交集、`templateVariables` 派生并集与 producer required invariant。
- 目录迁移前所有现有合法 `site.deployed` 模板变量在迁移后仍能通过校验。
- Webhook 编辑 UI 收到含 `team.member.updated` 等目录外历史事件的 subscription 时，显式显示警告和移除操作；移除前保存禁用，移除后可以保存，查看和停用不受影响。

### 业务生产者

focused 测试覆盖：

- 代表性的部署失败阶段产生一次 `site.failed`。
- deploy 和 rollback failure 都携带正确 operation。
- 幂等重放失败 deployment 返回现有 HTTP 200 failed terminal envelope 且不重复投递。
- 失败状态无法持久化时不投递。
- Console、CLI-managed API 和 deploy owner-transfer 的首次停用都产生 `site.disabled`。
- 重复 `disabled`、ACL-only 更新、pointer 状态不确定或既有流程未确认成功的操作不投递事件。
- workspace Console DELETE、platform-admin force DELETE 和 CLI-managed API 的成功删除都产生 `site.deleted`，且事件均带认证 actor。
- not found、snapshot error 和重复删除不投递。
- Webhook 投递异常时，部署失败、停用和删除接口维持原业务结果，并复用现有异步调度测试。

完整验证执行仓库根目录：

```bash
pnpm lint
pnpm test
```

## 兼容性与发布

- `site.deployed` 的事件名、header 和 Payload 不变。
- 现有只订阅 `site.deployed` 的 subscription 无需修改。
- 历史 subscription 若已保存 `site.failed` 或 `site.disabled`，上线后会开始收到对应事件；发布说明必须明确这一兼容行为。
- `team.member.updated` 等历史占位值继续没有目录项和生产者。
- `events_json` 和 `webhook_deliveries.event_type` 已支持多事件，无需 migration。
- Console internal list API 增加 `supportedEvents`，旧 Console 若只读取 `webhooks` 不受影响。
- 历史目录外事件在编辑表单中会显式显示为待移除项，不会因为前端只渲染当前目录而变成隐藏的非法 state。
- staging 和 production 使用各自 pages-api、D1 和 subscription 数据，不增加跨环境投递路径。

## 回滚

回滚时：

1. 移除三个新事件的业务生产调用点。
2. 从事件目录移除 `site.failed`、`site.disabled`、`site.deleted`。
3. 恢复 Console 只显示 `site.deployed`。

无需回滚数据库。已有 subscription 和 delivery 历史可以保留；失去生产者的事件会恢复为静默状态。审计中文映射和详情能力可以独立保留，不影响 Webhook 回滚。

## 文档同步

更新 `docs/architecture/xd-cell-console.md`：

- 把“第一版只支持 `site.deployed`”改为当前四个事件。
- 说明每个事件的精确触发时机。
- 说明安全 Payload 字段和禁止字段。
- 说明 best-effort、非 exactly-once 和接收方幂等责任。
- 说明新生产者复用现有 Webhook 投递和异步调度语义，不引入新的 route lifecycle 或 delivery 协议。
- 说明 workspace Console DELETE、platform-admin force DELETE 和 CLI-managed DELETE 都属于 `site.deleted` 生产路径。
- 说明历史 `site.failed` / `site.disabled` subscription 的启用行为。

审计展示属于 Console 内部交互，可在同一文档的管理员审计段补充“中文名称 + 原始枚举 + 摘要 + 详情”的展示约定。不更新 OpenAPI、CLI 文档或 pages skill。

## 验收标准

- 管理员无需理解英文枚举即可识别所有当前生产审计事件，同时仍能看到原始枚举用于排障。
- 多字段审计事件在列表中显示具体摘要，并能在详情层查看完整脱敏 metadata 和资源 ID。
- Webhook 新建和编辑表单展示四个真实可投递事件，事件清单来自 pages-api。
- persisted deployment 首次失败、站点首次停用、站点成功删除分别产生对应 delivery 记录。
- 重复、回滚或未提交成功的状态变化不产生误导事件。
- 新 Payload 不泄露错误原文、Secret、token、完整 URL 或 provider 资源信息。
- Webhook 失败不改变部署、停用或删除的业务结果。
- focused tests、`pnpm lint` 和 `pnpm test` 通过。
