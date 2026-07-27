# 管理员站点部署形态展示与筛选设计

## 背景

管理员后台的“站点管理”列表目前展示站点、Owner、可见性、状态和更新时间，但不能直接判断站点当前运行的是纯静态资源、纯 Worker，还是 Worker 与静态资源组合。管理员需要进入其它链路排查，无法在站点清单中快速定位不同部署形态。

平台已经在不可变的 `site_versions.deployment_shape` 中保存以下 resolved deployment shape：

- `assets-only`
- `worker-only`
- `worker-with-assets`

这些值描述某个版本的实际部署形态，不是用户或管理员选择的站点固定分类。

## 目标

- 在管理员“站点管理”列表展示当前生效版本的部署形态。
- 支持按部署形态筛选已加载的站点列表。
- 没有 active version 的站点显示并可筛选为“未部署”。
- 发布新版本或执行回滚后，列表刷新时自动反映当前 active version 的形态。

## 非目标

- 不在 `sites` 表新增或持久化站点类型。
- 不允许管理员手动修改部署形态。
- 不改变 CLI、发布 API、artifact detection 或部署行为。
- 不扩展站点详情页或部署记录页。
- 不在本次改动中增加服务端分页、搜索或筛选参数。

## 领域语义

后台 UI 使用“站点类型”作为易理解的列表列名，API 和代码继续使用现有领域名 `deploymentShape`，避免创造第二套含义相近的模型。

类型来源是 `site_routes.active_version_id` 指向的 `site_versions.deployment_shape`：

| API 值 | UI 文案 | 含义 |
| --- | --- | --- |
| `assets-only` | 静态资源 | 当前版本只发布静态资源 |
| `worker-only` | Worker | 当前版本只发布用户 Worker |
| `worker-with-assets` | Worker + 静态资源 | 当前版本同时包含用户 Worker 和静态资源 |
| `null` | 未部署 | 当前站点没有可关联的 active version |
| 其它非空字符串 | 未知类型 | 存储中存在当前前端尚未识别的未来或异常 shape |

“未部署”是管理员 UI 的展示和筛选状态，不加入平台 deployment shape 枚举，也不写入数据库。正式枚举使用 `assets-only`，不新增拼写 `asset-only`。

站点的 visibility（包括 `disabled`）与部署形态相互独立。只要 `active_version_id` 仍指向有效版本，就展示该版本的形态；没有 active version 时才展示“未部署”。

## 数据读取与 API

`store.listAdminSites()` 和 `store.getAdminSiteById()` 在各自现有的站点与路由查询中，通过以下相同约束关联 active version：

```text
site_versions.id = site_routes.active_version_id
site_versions.site_id = sites.id
```

第二个条件用于防止异常引用把其它站点的版本形态带入当前站点。两个查询都使用 `LEFT JOIN`，确保没有 active version 的站点仍可从管理员列表和详情 API 读取。D1 store 与测试用内存 store 的列表、详情读取路径使用相同的 active-version 解析语义。`site_versions.id` 已是主键，本次不新增索引或 migration。

store 映射后的管理员站点记录增加 nullable `deploymentShape`。管理员站点列表 API 和站点详情 API 使用同一个站点资源表示，每个 site 增加：

```json
{
  "deploymentShape": "assets-only"
}
```

当前正常写入值为现有三种 deployment shape；没有 active version 时为 `null`。API 对其它非空字符串保持原值，以便未来新增 shape 时旧版管理界面不会把已部署站点误判为“未部署”。该字段只描述部署形态，不返回 version ID、Worker 名称、provider resource ID 或其它内部资源信息。

列表与详情 API 保持字段一致是共享管理员站点资源契约的一部分；本次不在站点详情页 UI 展示该字段。

本次只修改管理员 BFF 返回，不把字段变成发布输入，也不修改开发期 OpenAPI 的用户侧边界。

## 管理员界面

站点列表在“Owner”和“可见性”之间增加“站点类型”列，使用紧凑 tag 展示中文文案。

列表工具栏增加单选类型筛选，选项为：

- 全部类型
- 静态资源
- Worker
- Worker + 静态资源
- 未部署

筛选复用当前页面的客户端过滤模型，并能与关键词、Owner 类型和站点状态筛选组合。工具栏计数继续显示组合筛选后的数量与当前已加载总数。

当前管理员 API 默认最多返回 200 个站点，因此类型筛选只作用于已加载集合。这与现有关键词、Owner 和状态筛选一致；全量服务端筛选和分页应作为独立需求处理。

## 异常和兼容处理

- 旧响应或测试 fixture 缺少 `deploymentShape` 时，前端按 `null` 处理并展示“未部署”。
- API 原样返回未知的非空字符串；前端显示“未知类型”，只在“全部类型”下出现，不归入“未部署”或三种已知类型筛选。
- active version 关联不到版本记录时，列表仍返回站点，并以 `null`/“未部署”呈现，不让单条数据异常阻断整个管理员列表。
- 不修改现有站点状态或访问控制语义。

## 测试策略

增加 focused `node:test` 覆盖：

1. D1 store 和测试用内存 store 的列表、详情读取路径都能从 active version 读取 `deploymentShape`，无 active version 或 active version 属于其它站点时返回 `null`。
2. 管理员站点列表和详情 API 返回三种合法 shape，并保持字段 nullable；未知非空 shape 在 store 和 API 层保持原值。
3. 前端正确映射三种 shape、“未部署”和未知非空值的文案。
4. 类型筛选覆盖三种正式 shape 和“未部署”，未知非空值仅出现在“全部类型”。
5. 类型筛选可以与现有关键词、Owner 和状态筛选组合。
6. 现有站点详情跳转和其它列表列保持不变。

实现完成后运行相关 focused tests，并运行仓库要求的 `pnpm lint` 与 `pnpm test`。

## 验收标准

- 管理员可以直接从站点列表识别当前部署形态。
- 管理员可以筛选任一部署形态或“未部署”站点。
- 发布或回滚改变 active version 后，刷新列表显示目标版本的 shape。
- 无 active version 的站点不会从列表消失，也不会被错误归入三种正式 shape。
- 不新增数据库字段、migration 或可编辑的站点类型。
- 不暴露敏感信息或 Cloudflare 内部资源标识。
