# XD Cell CLI 站点删除设计

## 背景

`pages-api` 已提供 `DELETE /.xd-pages/api/sites/{id}`，用于按现有权限模型软删除站点。当前 `@xd-cell/cli` 的 `sites` 命令只支持 `list` 和 `info`，用户只能通过 Console 删除站点，CLI 和 API 能力不一致。

## 目标

- 新增 `xd-cell sites delete <站点名>`。
- 默认在交互式终端要求确认，支持 `--yes` 显式跳过确认。
- 保持 CLI 的 slug 用户心智，同时复用 API 的 site ID 删除接口。
- 为 agent 和 CI 提供稳定、不会阻塞的 JSON 行为。
- 保持服务端现有权限、软删除、route snapshot 和 hostname reuse hold 语义不变。

## 非目标

- 不新增或修改 pages-api endpoint。
- 不实现站点恢复、永久删除或批量删除。
- 不改变 Console 的删除流程。
- 不允许 CLI 直接按内部 site ID 作为用户输入删除。

## 命令契约

```bash
xd-cell sites delete <站点名>
xd-cell sites delete <站点名> --yes
xd-cell sites delete <站点名> --yes --json
```

`--yes` 只允许用于 `sites delete`。`sites list --yes`、`sites info --yes` 和 `sites delete --details` 必须返回参数错误。

CLI 继续接受现有 `--token`、隐藏的 `--access-key`、环境选择、`--json` 和 `--help` 选项。

## 交互确认

普通文本模式且未传 `--yes` 时，CLI 在确认站点存在后显示：

```text
确认删除站点 "demo"? (y/N) 
```

只有忽略大小写后的 `y` 或 `yes` 执行删除。其它输入视为取消，输出：

```text
已取消删除站点：demo
```

取消是用户正常决策，退出码为 0，且不得发送 DELETE 请求。

`--json` 模式永不读取交互输入。`--json` 或非交互式环境未传 `--yes` 时返回 `SITE_DELETE_CONFIRMATION_REQUIRED`，action 指导用户在确认目标后添加 `--yes`，且不得发送 DELETE 请求。

## 数据流

1. 校验 `sites delete` 只接收一个站点 slug，并校验子命令专属 flags。
2. 使用现有站点读取流程按 slug 查询当前凭证可见的站点。
3. 对普通文本交互模式执行确认；`--yes` 跳过确认。
4. 使用查询结果中的 `site.id` 调用 `DELETE /.xd-pages/api/sites/{id}`。
5. 只在 API 成功后输出删除成功结果。

CLI 不复制服务端授权逻辑。个人站点 owner、团队 publisher/admin 和匹配 owner 且具有 deploy scope 的 access key 是否可删除，继续由 pages-api 判定。

## 输出与错误

文本成功输出：

```text
已删除站点：demo
```

JSON 成功输出：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "type": "site",
  "environment": "production",
  "site": "demo",
  "operation": "delete",
  "deleted": true
}
```

错误行为：

- 站点不存在或当前凭证不可见：沿用 `SITE_NOT_FOUND`。
- 缺少交互确认：返回 `SITE_DELETE_CONFIRMATION_REQUIRED`。
- 权限不足：透传 pages-api 的 `SITE_POLICY_FORBIDDEN` 安全诊断。
- route snapshot 写入失败等服务端错误：不输出成功结果，保留服务端公开错误码和 action。

## 实现边界

- `apps/pages-cli/src/args.js`：把 `--yes` 识别为 boolean flag。
- `apps/pages-cli/src/main.js`：提供可注入、可测试的可见文本确认输入，不复用隐藏 secret 输入。
- `apps/pages-cli/src/commands.js`：增加 `sites delete` 分支、子命令级 flag 校验、确认与 DELETE 调用，并同步 help。
- `apps/pages-cli/src/commands.test.js`、`apps/pages-cli/src/main.test.js`：覆盖命令行为和交互输入。
- `apps/pages-api/src/public-docs.js`、`docs/architecture/publishing-and-runtime.md`：同步公开命令示例和 CLI 契约。

不修改 `apps/pages-api/src/openapi.js` 或 handler，因为服务端删除合约已经存在且行为不变。

## 测试策略

- `--yes` 按 slug 查找站点，并使用返回的 site ID 发送 DELETE。
- 交互输入 `y` 或 `yes` 执行删除。
- 其它输入取消，退出成功且不发送 DELETE。
- `--json` 未传 `--yes` 返回稳定错误且不读取 stdin。
- 非 TTY 未传 `--yes` 返回稳定错误。
- 无效参数、`--yes`/`--details` 的子命令边界和 help 输出得到覆盖。
- API 返回权限或 route snapshot 错误时不输出成功结果。
- 运行 CLI focused tests、`pnpm lint` 和 `pnpm test`。

## 安全与兼容性

- CLI 不输出 token、cookie、session 或内部 provider 信息。
- 删除目标必须来自当前凭证可见站点的 API 返回结果，不能由用户伪造 site ID。
- JSON 和非交互环境默认 fail closed，避免 agent/CI 意外阻塞或删除。
- 这是新增子命令，不改变现有 `sites list`、`sites info` 或 `secrets delete` 行为。
