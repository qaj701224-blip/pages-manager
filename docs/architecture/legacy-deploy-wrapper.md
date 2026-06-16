# Legacy Deploy Wrapper

## 定位

现有 `apps/server` 已有 Cloudflare `/deploy` 能力。当前 preview 链路可以复用它，但必须被 gateway / worker 状态机包起来，不能作为绕过 issue、PR、Review gate 的用户入口。

## 当前调用路径

当前 ECS 验证路径：

```text
pages-worker
  -> 读取 PR head 下 allowedPath 文件
  -> POST https://api-staging.workers.xd.team/deploy
  -> callback gateway preview_deployed
  -> slack-notifier 更新状态卡
```

这样做的原因：

- Cloudflare staging API 有 IP allowlist。
- GitHub-hosted runner 出口 IP 动态，不适合作为白名单来源。
- ECS 出口相对固定，适合作为 preview deploy 调用方。
- 用户站点 workflow 不直接持有 Cloudflare 发布权限。

## 红线

- 不让普通用户用弱 `X-Pages-Token` 绕过 issue / PR / Review gate。
- 不从 floating branch 部署 production。
- 不让 Coding Agent、site-check、Slack Agent 持有 Cloudflare token。
- 不让 GitHub Actions 用户站点 workflow 持有 production deploy secret。

## Preview 和 Production

当前主线只要求 preview 自动闭环。

production 后续应使用受控 deploy 流程：

```text
PR merged
  -> gateway 记录 merge commit
  -> deployer 从 recorded merge_commit_sha 构建
  -> Cloudflare production deploy
  -> DeployRecord / AuditLog / Slack / issue / PR 回写
```

production deploy 不能从 floating branch 构建。

## 后续演进

后续可以把现有 `/deploy` 包装成 `deploy-core`，但当前代码还没有独立 `packages/deploy-core`。在真正新增前，文档不能把它写成当前事实。

建议演进顺序：

1. 为 preview / production 建立 `DeployRecord`。
2. 把 `/deploy` 调用收口到 worker / deployer。
3. production 只允许从已记录的 `merge_commit_sha` 部署。
4. 写 Cloudflare runtime snapshot。
5. 回写 Slack、issue、PR。
6. 锁定 legacy `/deploy` 的强认证和审计。
