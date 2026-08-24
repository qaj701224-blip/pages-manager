# 站点运行配置读取 API 设计

## 动机 / 背景

XD Cell v2 的站点级外部管理 API 已支持写入和删除 runtime vars 与 secrets：

- `PUT/DELETE /.xd-pages/api/sites/{site}/vars`
- `PUT/DELETE /.xd-pages/api/sites/{site}/secrets`

但相同路径不支持 `GET`。受控外部集成因此无法读取当前 vars 或 secret 名称，只能盲写配置。Console 已有组合读取接口 `GET /.xd-pages/api/console/sites/{siteId}/config`，但它当前允许 viewer 查看，并通过 `listEnabledSiteSecrets()` 读取和解密 secret 后才在响应投影中移除 value。

本设计为外部管理 API 增加读取能力，并统一外部 API 与普通 Console 的运行配置读取权限。secret value 从查询、应用服务到响应全程不可见。

## 目标

1. 在现有站点级 vars 和 secrets 路径上增加 `GET`。
2. 外部 API 和普通 Console 仅允许具备站点管理能力的主体读取运行配置。
3. 团队 viewer 既不能通过 API 读取，也不在 Console 中看到运行配置入口。
4. vars 返回名称、值、revision 和更新时间。
5. secrets 只返回名称、revision 和更新时间，不返回、读取或解密 value。
6. Public 与 Console 复用同一 application 读取能力，各自保留认证入口、错误映射和响应 envelope。
7. 同步开发期 OpenAPI、API 边界文档和 focused tests。

## 非目标

- 不增加 `xd-cell` vars/secrets list 命令，不改变 CLI help 或 pages-skill 用户入口。
- 不公开 `/openapi.json`，不把开发期 OpenAPI 变成普通用户手写 API 指南。
- 不改变 vars/secrets 的 PUT/DELETE 请求或响应。
- 不返回 secret value、密文、内部记录 ID、创建人或删除记录。
- 不修改 D1 schema 或 migration。
- 不把个人站点所有权数据迁移成新的角色数据，也不迁移现有 `site_members.role = 'owner'` 记录。
- 不改变 Platform Admin Console 对任意站点运行配置的现有访问能力。

## API 合约

### 读取 vars

```http
GET /.xd-pages/api/sites/{site}/vars
Authorization: Bearer <credential>
```

成功响应：

```json
{
  "vars": [
    {
      "name": "API_BASE",
      "value": "https://api.example.com",
      "revision": 2,
      "updatedAt": "2026-08-24T00:00:00.000Z"
    }
  ]
}
```

### 读取 secret 元数据

```http
GET /.xd-pages/api/sites/{site}/secrets
Authorization: Bearer <credential>
```

成功响应：

```json
{
  "secrets": [
    {
      "name": "API_TOKEN",
      "revision": 3,
      "updatedAt": "2026-08-24T00:00:00.000Z"
    }
  ]
}
```

两个列表均按 `name` 升序排列。空配置返回空数组。`revision` 为整数，`updatedAt` 为现有 D1 记录中的 ISO 8601 时间字符串。

Console 继续使用组合 envelope：

```json
{
  "config": {
    "vars": [],
    "secrets": []
  }
}
```

其中单条 var/secret 与外部 API 使用相同字段语义。

## 授权模型

### 人类主体

运行配置读取与运行配置写入使用相同的管理能力：

| 站点关系 | 有效管理角色 | 可读取 |
| --- | --- | --- |
| 个人站点 owner | `admin` | 是 |
| 团队成员 | `admin` | 是 |
| 团队成员 | `publisher` | 是 |
| 团队成员 | `viewer` | 否 |
| 非成员或非 owner | 无 | 否 |

`owner` 是个人站点的所有权关系，不是公开授权角色。授权边界将个人 owner 规范化为有效 `admin`，最终能力判断只接受 `admin` 或 `publisher`。现有 ownership 字段仍是推导个人站点有效角色的权威来源。

### Access Key 与 Connection assertion

- Access Key 除站点管理能力外，必须继续满足 `deploy:site` scope、site scope 和 owner/team 绑定。
- 只有 `read:site` scope 的 Access Key 不得读取运行配置。
- Cindy connection assertion 继续使用现有身份、站点关系和固定 scopes；团队 viewer 不因持有有效 assertion 获得运行配置读取权限。
- Public API 对已知但无管理权限的站点返回 403；不在凭证可见范围内的站点继续返回 404，避免扩大站点枚举能力。
- 普通 Console 对 viewer 的 config 请求返回 403 `SITE_PUBLISHER_REQUIRED`。
- Platform Admin Console 由独立的 platform-admin 鉴权保护，不受站点成员角色限制。

不能把所有主体简单建模为团队成员 role。团队所有的 Access Key 是非人类主体，其授权仍由 scope 与 owner/site binding 决定；统一的是“运行配置管理能力”，不是所有凭证的数据结构。

## 架构与数据流

### 共享 application 读取能力

在 `application/runtime-config` 增加只读 use case，并在 `application/ports/runtime-config.js` 暴露最小读取 port：

- `listVars(environment, siteId)`
- `listSecretMetadata(environment, siteId)`

Public 与 Console transport 不互相 import handler。两者分别完成各自认证和站点权限解析，然后调用共享 application reader，并在各自 lane 中构造响应。

读取方法保持独立：GET vars 不查询 secrets，GET secrets 不查询 vars；Console 组合接口并行或顺序调用两者后构造现有 envelope。

### Secret metadata repository

在 runtime-config repository 增加 metadata-only 查询。SQL 只选择响应所需的 `name`、`revision` 和 `updated_at`，过滤 `deleted_at IS NULL`，并按 `name ASC` 排序。

该查询不得选择 `encrypted_value`，不得调用 `decryptSiteSecretValue()`，也不得依赖 `SITE_SECRET_ENCRYPTION_KEY`。现有部署和 Worker 同步仍使用 `listEnabledSiteSecrets()` 获取解密后的运行时值，不改变其行为。

### Console UI

Workspace 站点详情根据现有 `site.permissions.canManage` 控制运行配置入口：

- admin/publisher 显示“运行配置”导航和页面；
- viewer 不显示该导航；
- viewer 直接访问 config URL 时不能触发配置查询，页面显示无权限状态或返回站点概览；
- 后端始终执行独立权限检查，UI 隐藏不作为安全边界；
- Platform Admin 站点详情继续显示运行配置。

## 错误处理

- 未认证或凭证无效：保持现有认证错误。
- 站点 slug 非法：保持现有 `SITE_SLUG_INVALID` / `SITE_SLUG_RESERVED`。
- 站点不在凭证可见范围：404 `SITE_NOT_FOUND`。
- 可见但无运行配置管理能力：403；Public 使用与现有 runtime-config mutation 一致的禁止语义，Console 使用 `SITE_PUBLISHER_REQUIRED`。
- Store 不提供读取 capability 或 D1 查询失败：503 `RUNTIME_CONFIG_UNSUPPORTED`，不返回底层异常或 SQL。
- GET 无请求体，不引入分页；现有 runtime binding 数量上限保证列表规模有界。

## 安全约束

1. secret GET 的 repository 查询结果不含 `encrypted_value` 或 `value`。
2. application DTO 和 Public/Console 响应中的 secret 项只允许 `name`、`revision`、`updatedAt`。
3. 错误、日志和测试失败输出不得包含 secret value 或 ciphertext。
4. 权限检查必须先于 vars/secrets repository 调用；viewer 请求不得触发配置查询。
5. Public API 继续只接受 HTTPS，并复用现有 access key / connection assertion 认证。
6. 不向未授权主体返回列表长度、名称、revision 或更新时间。

## 测试策略

### Domain 与 application

- 个人 owner 规范化为 `admin`；团队 `admin`/`publisher` 允许，`viewer` 拒绝。
- Access Key 的 `deploy:site`、site scope 和 owner/team binding 不可绕过。
- application reader 分别只调用所需 port，并对缺失 capability/查询异常 fail closed。

### Store

- vars 和 secret metadata 都按名称排序，只返回未删除记录。
- secret metadata 查询不选择密文字段，不需要 encryption key，也不调用解密函数。
- 返回的 revision 和 updatedAt 与权威记录一致。

### Public API

- GET vars 返回 `name/value/revision/updatedAt`。
- GET secrets 返回 `name/revision/updatedAt`，精确断言不存在 `value`、密文和其它内部字段。
- 个人 owner、团队 publisher/admin、合法 deploy-capable Access Key 成功。
- viewer、read-only Access Key 返回 403，并断言 Store 列表方法未调用。
- 不可见站点返回 404；无认证返回现有认证错误；不支持的方法仍返回 405。

### Console API 与 UI

- 个人 owner、团队 publisher/admin 继续读取现有 config envelope。
- viewer 的 config API 返回 403，且 Store 列表方法未调用。
- Workspace viewer 看不到运行配置导航，直接 URL 不展示配置；admin/publisher 和 Platform Admin 保持可见。
- Console 中 vars/secrets 的版本和更新时间展示不回退。

### 合约与回归

- 更新 `apps/pages-api/src/openapi.js` 和对应 OpenAPI tests。
- 更新 `docs/api-boundary.md`，把受控集成能力从 vars/secrets mutation 扩展为 read/mutation。
- 运行 pages-api、pages-console、architecture focused tests，再运行 `pnpm lint` 和 `pnpm test`。

## 风险与回滚

- **Console 行为收紧**：viewer 从“只读运行配置”变为完全不可见。通过 UI 隐藏、直接 URL 后端 403 和角色矩阵测试锁定预期。
- **Access Key 语义误收紧**：不能只检查人类 role；必须保留 scope 与 owner/site binding 测试。
- **Secret 泄漏**：通过 metadata-only SQL、精确响应字段断言和明文 marker 回归测试防止。
- **共享读取过度耦合**：application 暴露两个独立方法，避免外部单项 GET 读取另一类配置。

回滚时可移除两个 Public GET 分支、恢复 Console viewer 导航和读取权限，并保留 metadata-only repository 查询；保留该查询不会改变写入、部署或 Worker runtime 行为。
