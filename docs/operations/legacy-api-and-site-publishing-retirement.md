# Legacy API 与 Site Publishing 退休手册

本文是 v1 `apps/server` 墓碑化和 Site Publishing Lane 冻结的当前运维真相源。代码边界于 2026-08-05 收敛；production 是否已经生效，以对应 GitHub Actions 手动部署记录和运行态验证为准。

## 目标

- `apps/server` 不再执行任何旧管理 API 请求，只返回稳定的退休协议。
- Site Publishing 不再创建或继续推进 `PublishingJob`。
- Platform Dev Lane 保持可用。
- 存量站点、访问能力、Cloudflare 资源和历史数据全部保留。
- 不做 v1 到 v2 的自动迁移，不把 Site Publishing Preview 改造成 v2 deployer。

## 运行时协议

### `apps/server`

精确的 `GET /health` 和 `HEAD /health` 返回 `200`。其它路径和方法在 IP 校验、Router、请求体解析和业务 handler 前返回：

```json
{
  "error": "LEGACY_API_RETIRED",
  "message": "如果你使用 Cindy 客户端，请使用 xd-sites 插件；如果无法安装或找不到插件，请先更新 Cindy 客户端。非 Cindy 客户端请使用 https://skills.xindong.com/skills/xd-cell 的 skill。"
}
```

HTTP status 为 `410 Gone`，`Content-Type` 为 JSON，并带 `Cache-Control: no-store`。响应不增加 `hint`、`migration` 或按客户端猜测身份的分支。

### Site Publishing Lane

统一错误码和文案：

```json
{
  "error": "PUBLISHING_LANE_RETIRED",
  "message": "站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。"
}
```

当前冻结点：

- `POST /api/publishing-jobs` 返回 `410`；PublishingJob list/detail/events 读取接口保留。
- Slack 新建、确认、follow-up、retry、reopen、追加诊断和转人工写入不创建、不恢复、不修改 GitHub、不启动 Site Publishing worker；历史状态、review 和 timeline 查询保持只读。
- GitHub Review Agent、site-check、Issue/PR resource webhook 保留 delivery/comment/run 历史记录，但对 Site Publishing 返回 `200` ignored，不推进状态。
- executor callback 和 review-gate reconcile 对 Site Publishing 返回 `200` ignored，不启动 worker。
- pages-worker 的 `/internal/publishing-jobs/start` 对 Site Publishing 返回 `410`，只继续接受 `workItemKind=platform_dev`。
- `project-index.yml`、`pages-agent.yml` 和 `pages-preview.yml` 保留历史 workflow body，仅保留未被生产调用的 `workflow_call` 输入 schema，并额外使用静态 `if: ${{ false }}` 冻结 job。
- `pr-site.yml` 不再提供 `workflow_dispatch`，仍保留 `pull_request` 触发，用于校验已有或人工提交的 `sites/**` PR。

代码没有环境变量或运行时 feature flag 可以重新开启 Site Publishing。旧实现仅作为 dormant historical code 和回归测试参考保留。

## 必须保留的资源和数据

不得在本次退休中删除、解绑或清空：

- `pages-manager` API Worker
- `api.workers.xd.team` Custom Domain 和 API route
- `SITES` KV
- 旧站点 Worker、exact route、DNS、hostname claim
- 存量站点内容和访问能力
- PublishingJob、job event、Slack session、work item link、Review Agent comment、site-check run、GitHub delivery 等历史记录
- `apps/worker/src/jobs/preview.js`、旧 handler、旧 workflow body 和相关历史实现

`api.workers.xd.team` 还承担旧 partial-zone 链路的资源锚点。API 墓碑化不等于删除域名或 Worker。

## 不在本次范围

- 不把 `/deploy` 调用方迁移到 XD Cell v2。
- 不为历史 PublishingJob 自动创建 v2 站点。
- 不删除旧 preview 或 production 站点资源。
- 不自动合并、关闭或删除历史 Issue/PR。
- 不自动部署 Cloudflare 或 ECS production。

## Production 上线顺序

必须按以下顺序人工执行，不能先部署 `apps/server` 410：

1. 合入静态 workflow 冻结，确认默认分支上的 `project-index.yml`、`pages-agent.yml`、`pages-preview.yml` 仅保留未被生产调用的 `workflow_call` schema、无手工/API dispatch 且 job 不可执行，`pr-site.yml` 已无手工 dispatch。
2. 手动部署 ECS runtime 的 `pages-gateway` 和 `pages-worker`，让创建、续接、webhook、callback 和 worker 直调入口全部冻结；同时验证 Platform Dev 创建、callback 和 `platform-agent.yml` dispatch 不受影响。
3. 取消或等待排空仍在运行的 `project-index.yml`、`pages-agent.yml`、`pages-preview.yml` 和由其触发的 Site Publishing run。旧 ref 上的 workflow 也要检查，不能只看默认分支。
4. 将仍处于可推进状态的 Site PublishingJob 标记为 `cancelled`，原因使用 `PUBLISHING_LANE_RETIRED`；保留原记录和事件，不做物理删除。该数据操作需由维护者在 production 数据库中单独审核执行，本仓库不自动运行 destructive migration。
5. 确认没有 Site PublishingJob 处于 `previewing`、`fixing`、`generating_page` 等活动状态，没有 pages-worker Site Publishing start，也没有活动的 Site Publishing workflow run。
6. 最后手动触发 v1 `Deploy Production`，部署 `apps/server` 的 410 墓碑响应。
7. 运行上线后验证，确认旧 API 返回正确文案、历史站点仍可访问、Platform Dev 仍可用。

## 上线后验证

- `GET https://api.workers.xd.team/health` 返回 `200`。
- `POST /deploy`、`GET /list`、`GET /openapi.json`、未知路径和非 GET 方法返回 `410 LEGACY_API_RETIRED`，且 `message` 完整。
- 旧 `<site>.workers.xd.team` 站点仍可按原访问策略打开。
- Gateway `POST /api/publishing-jobs` 返回 `410 PUBLISHING_LANE_RETIRED`。
- PublishingJob 历史 list/detail/events 仍可读取。
- Slack Site Publishing 新建、续接、重试、恢复、追加诊断和转人工写入只返回退休提示，不产生 GitHub 写入或 worker start；历史诊断保持只读。
- GitHub Site Publishing webhook/callback 返回 `200` ignored，历史 delivery/comment/run 仍写入。
- pages-worker 直接接收 Site PublishingJob 时返回 `410`；Platform Dev start 仍返回成功结果。
- Cloudflare Worker、Custom Domain、route、KV 和存量站点资源数量没有因本次上线减少。

## 回滚

若退休响应本身导致非预期问题，可手动部署上一版 Gateway、worker 或 `apps/server` commit。回滚不需要重建站点或 Cloudflare 资源，因为本方案没有删除它们。

重新开启 Site Publishing 属于新的产品决策，不能通过环境变量临时切换；必须显式修改静态 guard、workflow gate、测试和本文，并重新走 review 与人工部署。
