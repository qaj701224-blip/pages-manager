# Slack Agent Diagnostics

本文件是 [slack-agent-runtime.md](./slack-agent-runtime.md) 的任务诊断体验拆分页。Slack session、运行时协议和 Slack 输出链路仍以 runtime 文档为准。

试用中暴露的更完整产品问题和后续优先级见 [slack-agent-product-issue-backlog.md](./slack-agent-product-issue-backlog.md)。本文件只描述诊断入口的目标形态；列表查询兜底、二次补充写入 Issue / PR、统一 Work Item 心智、按影响范围生成测试闭环等仍按 backlog 逐项推进。

Review Agent 评论、blocking / suggestion / note 摘要和 site-check 结论的 Slack 展示规则见 [slack-review-results-summary.md](./slack-review-results-summary.md)。Review 结果摘要是诊断类只读能力，但比泛化任务诊断更具体，应独立维护。

## 产品定位

Slack Agent 必须优先解决任务执行的黑盒感。用户可以自由提问：

```text
这个任务现在怎么样？
为什么 issue 没创建成功？
issue 创建了，为什么 PR 没出来？
帮我查一下这个任务最近卡在哪里。
能不能重试？
```

用户不需要知道背后是 gateway、worker、GitHub Actions、ECS、MySQL 还是 callback。Slack 可见文案只使用“任务、阶段、Issue、PR、Preview、Workflow、失败原因、建议操作”这类产品语义。

## 权限分层

系统执行时必须按权限分层：

- 默认开放：查询当前任务状态、issue / PR / preview 关联、任务 timeline、卡住阶段解释、受控日志摘要、GitHub Actions 状态和下一步建议。
- 需要确认：创建 issue、追加诊断 comment 到 issue、重试失败流程、重新 dispatch workflow、恢复已关闭任务。
- 必须收口：创建 PR、合并 PR、生产部署、删除资源、批量关闭 issue / PR、读取 secret、任意查询 ECS 原始日志、直接 shell 到 ECS。

这些权限由 gateway 在执行时重新校验，不能只信任 Agent 的 toolCall。
自然语言里出现“重试”“追加诊断”“转人工”时，Slack Agent 先返回诊断报告和按钮；真正写 Issue comment、重新触发处理流程或记录人工排查请求，只能来自按钮交互。

## 报告形态

诊断报告面向用户，而不是面向底层系统。推荐回复形态：

```text
这个任务卡在 PR 创建前。
当前状态：Issue 已创建
Issue：#123
最近阶段：Workflow 已请求启动
失败原因：GitHub Actions dispatch 返回 403，可能是 token 权限不足。
关联日志：最近 30 分钟有 1 条匹配错误。
建议操作：可以重试，或把诊断结果追加到 Issue。
```

诊断报告至少包含：

- 当前用户可理解状态。
- 关联 Issue / PR / Preview / Workflow。
- 最近成功阶段和当前阻塞阶段。
- 失败原因或无法判断原因。
- 受控日志摘要或 request id。
- 可执行的下一步按钮。

推荐按钮：

- 查看 Issue。
- 查看 Workflow。
- 重试：仅在当前阶段可重新触发处理流程、且审批已满足时展示。
- 追加诊断到 Issue：把当前用户可见诊断摘要写入关联 Issue。
- 转人工排查：记录人工排查请求，并在有关联 Issue 时追加诊断摘要。

## 诊断事实

诊断内部可以关联这些事实，但默认不把内部字段名展示给用户：

- 用户原文显式给出 `PR #123`、`Issue #123` 或 GitHub issue / PR URL 时，gateway 必须把它当成用户指定目标；即使当前 DM 有多个 active session，也不能先返回会话歧义提示。
- Slack 消息是否进入入口服务。
- 是否成功创建 Slack 会话。
- 是否生成站点发布任务或平台研发任务。
- issue 创建是否成功，以及失败属于 GitHub API、权限、label、repo 配置还是输入校验。
- issue 创建后是否进入下一阶段。
- project index 是否完成。
- pages-agent workflow 是否 dispatch。
- branch / PR / preview 是否创建。
- callback 是否回到平台。
- 状态机是否卡住或收到过期 callback。

## 日志摘要

日志摘要能力不能做成通用日志搜索框。默认只围绕当前 Slack thread、当前任务、issue 或 PR 查询；默认时间窗为最近 30 分钟，可在确认后扩大到 2 小时；服务范围必须白名单化，例如 `pages-gateway`、`pages-worker`、`slack-agent`；返回 Slack 前必须脱敏 token、cookie、authorization、secret-like 字段。

Slack 只展示摘要、关键错误、request id 和内部日志系统链接，不刷大段原始日志。
