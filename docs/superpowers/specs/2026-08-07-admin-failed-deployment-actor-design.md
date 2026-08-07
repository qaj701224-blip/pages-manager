# 管理后台失败部署归属与操作人展示设计

## 背景

管理后台“失败部署”列表当前只展示“归属”。该字段通过 `deployments LEFT JOIN sites` 读取站点 owner。新站点在创建失败时没有对应的 `sites` 记录，但 API 和前端会把空 owner 默认显示成 `user / 用户`，导致维护者误以为失败部署已经存在个人归属，同时无法直接看到部署发起人。

`deployments` 已持久化 `actor_id`、`actor_user_id` 和 `actor_type`，因此本次修复不需要数据库迁移。

## 目标

- “站点归属”只表达已经持久化站点的 owner。
- 新站点未创建成功时，归属显示“站点未创建”，不得显示泛化的“用户”。
- 失败部署列表新增“操作人”，展示 deployment actor 对应的姓名、邮箱和安全标识。
- 保留 `source`，但明确它是“客户端来源”，不把 `cli` 当作 Cindy 或用户身份。
- 管理员站点详情的部署记录使用相同的 actor 响应模型，避免两个管理界面语义分叉。

## 非目标

- 不增加或修改 D1 schema。
- 不把 actor 当成失败站点的最终 owner。
- 不持久化新的认证渠道字段，也不承诺从历史 deployment 精确区分 Cindy Connection 和特殊 Access Key。
- 不修改公开部署 API、CLI、webhook 或部署执行逻辑。
- 不在本次修复中细化 `SITE_CREATE_FAILED` 的底层错误码。

## 数据读取与响应模型

Dashboard 和管理员站点部署查询都增加：

```sql
sites.id AS joined_site_id,
actor_users.email AS actor_user_email,
actor_users.realname AS actor_user_realname

LEFT JOIN users AS actor_users
  ON actor_users.user_id = deployments.actor_user_id
```

`owner.state` 必须根据 `joined_site_id` 是否存在判断，不得根据可能为空的 owner profile 字段推断。

内部管理 API 的 deployment 响应增加：

```json
{
  "owner": {
    "state": "persisted",
    "type": "user",
    "id": "usr_...",
    "email": "owner@xd.com",
    "displayName": "Owner"
  },
  "actor": {
    "type": "access_key",
    "id": "ak_...",
    "userId": "usr_...",
    "email": "actor@xd.com",
    "displayName": "Actor"
  },
  "source": "cli"
}
```

当 `sites` join 不到记录时：

```json
{
  "owner": {
    "state": "not_created",
    "type": null,
    "id": null,
    "email": null,
    "displayName": null
  }
}
```

历史记录无法解析用户时仍返回 deployment 中已有的 actor 标识：

- `actor.type` 来自 `actor_type`。
- `actor.id` 来自 `actor_id`。
- `actor.userId` 来自 `actor_user_id`。
- 邮箱和姓名无法关联时为 `null`，前端显示安全的 ID 或“未知操作人”。

`actor.userId` 表示该凭证关联的用户身份；对普通 Access Key 而言，它不能单独证明该用户本人手动执行了操作。

不返回 Access Key hash、token、Cindy membership ID 或其它认证凭证数据。

## UI 行为

Dashboard 表头调整为：

1. 部署
2. 站点
3. 客户端来源
4. 站点归属
5. 操作人
6. 阶段
7. 错误
8. 时间

归属展示规则：

- `owner.state === "not_created"`：显示中性标签“未创建”和正文“站点未创建”。
- `owner.state === "persisted"`：继续使用现有 user/team owner 展示。

操作人展示规则：

- 优先显示姓名，次行显示邮箱。
- 无姓名时优先显示邮箱。
- 无用户资料时显示 `actor.userId` 或 `actor.id`。
- 全部为空时显示“未知操作人”。
- 可显示 `user`、`access_key` 或 `system` 类型标签，但不根据 actor 形态推断 Cindy Connection。

管理员站点详情的部署记录将“归属”列替换为“操作人”。该页面本身已经限定在具体站点下，重复展示当前站点 owner 的排障价值低于展示实际发起人。共享的 `SiteDetail` 组件仅在 admin scope 使用 actor 列；普通 workspace 站点详情继续保留现有归属展示。

## 兼容性与影响范围

- 管理 API 仅增加字段，并给 `owner` 增加 `state`；不删除现有 owner 字段。
- 只影响 pages-console 的管理员页面，不影响普通用户站点目录。
- SQL 只增加一个按 `users.user_id` 主键的 `LEFT JOIN`；Dashboard 仍限制最近 10 条，站点详情仍限制最多 100 条。
- 现有历史 deployment 可直接显示 actor，无需回填。

## 测试

- store 查询测试：Dashboard 和管理员站点部署查询均关联 `actor_users`。
- store 映射测试：无 site 行时 owner 为 `not_created`，actor 仍能解析。
- API 测试：失败新站点返回 `owner.state = not_created` 和具体 actor；已有团队站点保持 `persisted` owner。
- UI model 测试：覆盖未创建 owner、用户/Access Key/未知 actor 的展示降级。
- 页面回归测试：Dashboard 有“客户端来源”“站点归属”“操作人”，站点详情部署记录展示操作人。

## 发布与回滚

需要同时部署 pages-api 和 pages-console。先部署 staging 并验证两类记录：已有站点上传失败、新站点创建失败。回滚时可一起回滚管理 API 和 Console；数据库没有迁移或不可逆状态。
