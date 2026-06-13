# API Entry

## 定位

`pages-manager` MVP 需要同时支持两类入口：

```text
Slack
  面向普通用户和默认流程

Gateway API
  面向高级用户、管理员、CI、补偿和批量操作
```

API 是正式入口，不是调试后门。API 最终仍然创建 `PublishingJob`，并复用同一套 issue、PR、review、preview deploy、audit 和权限判断。production merge / deploy 是 Preview 闭环之后的后续能力。

CLI 暂不考虑。后续如果需要 CLI，也应该只是 API 的薄客户端，不新增独立业务通道。

## 入口关系

```text
高级用户 / 管理员 / CI
  ↓ HTTPS
pages-gateway API
  ↓
PublishingJob
  ↓
issue → patch → PR → review → preview deploy
```

Slack 和 API 的区别只在“需求从哪里来”：

| 入口 | 需求来源 | 身份来源 | 回写 |
| --- | --- | --- | --- |
| Slack | thread / slash command / app mention | `ExternalIdentityBinding(slack)` | Slack thread + issue / PR |
| API | request body、文件引用、CI payload | SSO session / PAT / service token | API response + issue / PR，可选 Slack |

## API MVP

建议最小 API：

```text
POST /api/publishing-jobs
GET  /api/publishing-jobs/:jobId
GET  /api/publishing-jobs/:jobId/events
POST /api/publishing-jobs/:jobId/retry
GET  /api/sites
GET  /api/sites/:siteProjectId
GET  /api/slack-events/:slackEventId
POST /api/slack-events/:slackEventId/replay
```

`POST /api/publishing-jobs` 的请求必须带 source：

```json
{
  "source": "api",
  "idempotencyKey": "ci-build-20260611-001",
  "intent": "create_site",
  "employeeSlug": "zhangsan",
  "siteSlug": "q2-report",
  "title": "Q2 Report",
  "brief": "Create an internal Q2 report page..."
}
```

gateway 写入：

```text
PublishingJob.source = api
PublishingJob.requested_by = authenticated user or service account
PublishingJob.idempotency_key = request.idempotencyKey
AuditLog.actor = authenticated user or service account
```

API 创建 job 必须幂等。调用方可以通过 `Idempotency-Key` header 或 request body 的 `idempotencyKey` 提供稳定键；gateway 使用解析后的 actor 参与唯一约束：

```text
unique(source, requested_by_type, requested_by_id, idempotency_key)
```

重复请求命中同一个 key 时，gateway 返回已有 `PublishingJob`，不能重复创建 issue / PR / preview deploy。

## 鉴权

API 支持三类身份：

| 类型 | 用途 | 说明 |
| --- | --- | --- |
| SSO session | 高级用户从控制台或内部工具调用 | 绑定内部 `User` |
| Personal access token | 自动化脚本 | scope 绑定用户和过期时间 |
| Service token | CI 或平台集成 | 必须绑定 service account 和最小权限 |

规则：

- API 不能接受调用方手写的 `employee_id` / `employeeSlug` 作为身份结论。
- gateway 必须从 token/session 解析内部 `User` 或 service account。
- 操作某站点前必须检查 `SiteAdminGrant`、owner scope 或 admin。
- 创建型 API 必须提供幂等键。
- 所有 API 操作必须写 `AuditLog`。

## 授权范围

API request body 里的 `employeeSlug`、`siteSlug`、`siteProjectId` 都只是目标资源，不代表调用者有权限。

授权规则：

- SSO session 只能默认操作本人 owner scope。
- Personal access token 只能默认操作 token 所属用户的 owner scope。
- 跨员工、跨 owner scope 操作必须有 `SiteAdminGrant`、platform admin role 或明确的 owner scope grant。
- Service token 必须绑定 `ServiceAccount`。
- `ServiceAccount` 必须通过 `SiteAdminGrant(grantee_type=service_account)`、allowed owner scope 或 allowed site project 获得权限。
- service token 的 `scopes_json` 只能缩小权限，不能扩大 `ServiceAccount` 本身的授权范围。

建议最小 token 模型：

```text
ApiToken
  actor_type: user | service_account
  actor_id
  token_hash
  scopes_json
  allowed_owner_scope_ids_json
  allowed_site_project_ids_json
  expires_at
  status
```

## 权限边界

API 可以做：

- 创建发布请求。
- 查询 job / site / deploy 状态。
- 查看 issue / PR / review 链接。
- 重试失败 stage。
- 管理员回放 SlackEvent。
- CI 创建受限的发布请求。

API 不能做：

- 直接写 `sites/<employee>/<site>/`。
- 绕过 issue / PR。
- 绕过 review。
- 直接 production deploy floating branch。
- 读取 Slack bot token、Cloudflare token、auto-merge token。
- 修改 `.github/`、`apps/`、`packages/`、`k8s/` 并自动合并。

## 和 Slack 的关系

MVP 必须结合 Slack，但 API 也是正式入口。

默认用户路径：

```text
Slack → PublishingJob → PR → preview deploy → Slack 回写
```

高级用户 / CI 路径：

```text
API → PublishingJob → PR → preview deploy → API 状态查询 + issue / PR 回写
```

如果 API job 需要同步到 Slack，可以允许 request body 提供 channel/thread：

```json
{
  "source": "api",
  "intent": "update_site",
  "employeeSlug": "zhangsan",
  "siteSlug": "q2-report",
  "brief": "Update the Q2 report page",
  "slackThread": {
    "channelId": "C123",
    "threadTs": "1710000000.000100"
  }
}
```

这种情况下 gateway 必须校验调用者有权限把进度写入该 Slack thread，并记录关联。

## MVP 成功标准

- 高级用户能通过 API 创建 `PublishingJob`。
- API 创建的 job 与 Slack 创建的 job 走同一套状态机。
- API 能查询 job 进度。
- API retry 会生成新的 `JobStageAttempt`。
- API 操作全部写审计。
- API 不能绕过 issue / PR / review / preview deploy 边界。
