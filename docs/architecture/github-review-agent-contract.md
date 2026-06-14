# GitHub Review Agent Contract

## 定位

MVP 的 review 重点是实时读取 GitHub Enterprise PR 中 GitHub Review Agent 提交的 comment。

Greptile 如果接入，视为一种 GitHub Review Agent。平台不把 Greptile 逻辑写进 coding agent，而是通过 GitHub webhook 接收它在 PR 上产生的 review、inline comment、issue comment 或 check output。

当前仓库里 GitHub 自动 review 也可能来自 Codex 连接器，bot login 在不同 GitHub API 表面可能表现为 `chatgpt-codex-connector` 或 `chatgpt-codex-connector[bot]`。MVP 默认 allowlist 需要同时覆盖 Greptile、Copilot PR reviewer 和 Codex connector；企业环境上线前再用 `GITHUB_REVIEW_AGENT_LOGINS` / `GITHUB_REVIEW_AGENT_ALLOWLIST` 收敛到实际安装的 GitHub App。

## Allowed Review Agents

配置项：

```text
GITHUB_REVIEW_AGENT_ALLOWLIST
```

建议结构：

```json
[
  {
    "provider": "greptile",
    "githubAppSlug": "greptile",
    "botLogins": ["greptile[bot]", "greptile-bot"],
    "checkRunNames": ["Greptile", "greptile-review"],
    "enabled": true
  },
  {
    "provider": "codex",
    "githubAppSlug": "chatgpt-codex-connector",
    "botLogins": ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"],
    "checkRunNames": ["Codex Review"],
    "enabled": true
  }
]
```

匹配规则：

- GitHub App slug 命中。
- bot login 命中。
- check run name 命中。
- repo 在 allowlist 中。

未命中 allowlist：

- 不写入 blocking review。
- 不触发 auto-fix。
- 可以作为普通人工评论记录到 `JobEvent`，但不能影响 `trusted-auto`。

## Webhook Events

gateway 接收：

```text
pull_request_review
pull_request_review_comment
issue_comment
check_run
check_suite
```

所有 webhook 必须先写 `GitHubWebhookDelivery`：

```text
unique(repo_full_name, delivery_id)
```

重复 delivery 不重复创建 `ReviewAgentComment`。

如果配置了 `GITHUB_WEBHOOK_SECRET`，gateway 必须校验 `X-Hub-Signature-256`。本地 smoke 可以临时不配 secret；任何公网 gateway / staging gateway 都必须配置。

当前代码快照：

- `apps/gateway/src/github-review.js` 负责 allowlist、归一化和分类。
- `apps/gateway/src/handlers.js` 的 `/integrations/github/webhook` 先记录 delivery，再处理 Review Agent 事件。
- 归一化 `ReviewAgentComment` 必须保存到 MySQL；当前 `MemoryGatewayStore` 只作为历史代码和测试 fixture，迁移时保持同样唯一键。
- `pull_request_review` approved / LGTM 类 note 且无 open blocking / unknown comment 时，gateway 把 job 推进到 `previewing` 并调用 worker。
- `pull_request_review_comment` / `issue_comment` 中的 blocking 内容会把 job 推进到 `changes_requested`。
- 未命中 allowlist 的 bot 不影响 gate，不触发 preview 或 fix。

当前尚未落地：

- 30-60 秒 debounce。
- 自动 `pages-agent.yml(mode=fix)` 修复轮次。
- required checks / site-check webhook 聚合进 preview gate。
- Slack notifier 独立回写。

## Normalization

不同来源归一化为 `ReviewAgentComment`。

| GitHub event                  | source_type      | ID                                   |
| ----------------------------- | ---------------- | ------------------------------------ |
| `pull_request_review`         | `review_summary` | review node id                       |
| `pull_request_review_comment` | `inline_comment` | comment node id                      |
| `issue_comment` on PR         | `issue_comment`  | comment node id                      |
| `check_run` output            | `check_run`      | check run node id + annotation index |

必填字段：

```text
repo_full_name
pr_number
github_comment_node_id
source_type
review_agent_login
body
classification
status
first_seen_delivery_id
last_seen_delivery_id
```

inline comment 额外记录：

```text
path
line
diff_hunk
```

check output 如果没有自然 comment id，生成稳定 fallback：

```text
check:<check_run_id>:annotation:<path>:<line>:<hash(body)>
```

## Status Updates

同一个 GitHub comment 发生变化时，必须更新同一条 `ReviewAgentComment`。

| GitHub action     | ReviewAgentComment.status          |
| ----------------- | ---------------------------------- |
| created/submitted | `open`                             |
| edited            | 保持原 status，更新 body/body_hash |
| deleted           | `deleted`                          |
| dismissed         | `dismissed`                        |
| outdated          | `outdated`                         |
| resolved          | `resolved`                         |

不得把 edited/deleted/dismissed 当作新 comment 追加。

## Classification

分类值：

```text
blocking
suggestion
note
unknown
```

MVP 分类可以先用规则 + allowlist agent metadata：

| classification | 规则                                                                                                      | 动作                                  |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `blocking`     | review state 为 changes requested，或正文含明确必须修复项，或 check conclusion failure 且可定位到站点代码 | 进入 `changes_requested`，可触发 fix  |
| `suggestion`   | 建议优化，但非必须                                                                                        | 回写 Slack/issue，不阻塞 Preview gate |
| `note`         | 总结、说明、通过信息                                                                                      | 记录和回写                            |
| `unknown`      | 无法判断、来源格式变动、解析失败                                                                          | 等待人工确认，不自动修复              |

`unknown` 的硬规则：

- 不触发 `AgentRun(type=fix)`。
- 不允许进入 `trusted-auto`。
- 必须回写 Slack，提示需要人工分类或确认。

## Debounce And Review Round

Review Agent 可能连续提交多条 comment。不能每条 comment 都立刻触发一轮 fix。

MVP debounce：

```text
same repo + pr + head_sha
  wait 30-60 seconds after last allowed Review Agent event
  collect open blocking comments
  create one AgentRun(type=fix)
```

review round key：

```text
repo_full_name + pr_number + head_sha + review_agent_provider
```

同一个 round 只能创建一个 active fix run。

## Fix Trigger

触发修复的条件：

- PR 关联有效 `PublishingJob`。
- job status 在 `reviewing | changes_requested`。
- 有 open blocking `ReviewAgentComment`。
- 没有 open unknown comment。
- 当前没有 running fix attempt。
- `fix_round_no < max_fix_rounds`。
- PR diff 仍只修改目标 `allowedPath`。

fix 输入：

```json
{
  "mode": "fix",
  "publishingJobId": "job_...",
  "prNumber": 123,
  "branchName": "sites/job-job_123-zhangsan-profile",
  "headSha": "abc123",
  "reviewAgentCommentIds": ["rac_1", "rac_2"],
  "fixRoundNo": 1
}
```

fix 输出仍走 controlled commit，不允许 coding agent 直接 push。

## Max Fix Rounds

MVP 默认：

```text
max_fix_rounds = 1
```

超过后：

- job 保持 `changes_requested`。
- Slack 回写“自动修复次数已用完，需要人工处理”。
- issue / PR comment 回写 open blocking comment 摘要。
- 不再自动 dispatch `pages-agent.yml(mode=fix)`。

## Slack And PR Feedback

每轮 review 入库后，`slack-notifier` 回写：

- 新增 blocking 数量。
- 新增 suggestion/note 数量。
- unknown 是否需要人工确认。
- 是否开始 auto-fix。
- fix round 完成后等待新一轮 review。

executor 不直接发 Slack。

## Preview Gate And Merge Gate

第一优先级使用 Preview gate；production merge gate 是后续能力。

允许 Preview candidate 需要：

- required checks passed。
- `pages-site-policy` passed。
- no open blocking `ReviewAgentComment`。
- no open unknown `ReviewAgentComment`。
- no human changes requested review。
- PR only touches `allowedPath`。

后续允许 production merge candidate 时，还需要：

- approval mode allows merge path。
- production approval policy passed。
- deploy target is exact `merge_commit_sha` after merge。

## 乱序到达合同

GitHub webhook 和 executor callback 之间没有顺序保证。Review Agent 可能在 `pages-agent.yml` 已创建 PR 后立即评论，而 `pr_created` callback 可能因为 runner、tunnel、Ingress 或 gateway 重试稍后才到。

必须按下面规则实现：

```text
Review Agent issue_comment / pull_request_review 先到
  ↓
gateway 记录 GitHubWebhookDelivery
gateway 归一化并持久化 ReviewAgentComment
gateway 暂时找不到 PublishingJob 或 PR link 时，不丢弃 comment
  ↓
pages-agent.yml pr_created callback 后到
  ↓
gateway 绑定 job.prNumber / job.headSha / IssueLink
gateway 回放 repo + prNumber + headSha 下已有 ReviewAgentComment
  ↓
blocking / unknown 存在：不进入 Preview
note / suggestion 且 required checks 通过：进入 previewing
```

实现要求：

- `ReviewAgentComment` 唯一键必须独立于 `PublishingJob` 存在，至少由 `repo_full_name + github_comment_node_id` 或等价 normalized key 保证幂等。
- `head_sha` 可以是 GitHub Review Agent 正文里的 7 到 40 位短 SHA；匹配 job 时允许与 40 位 head SHA 做前缀匹配，但持久化 job 仍保存完整 SHA。
- `pr_created` callback 后必须主动计算一次 review gate，不能只等待后续新 review webhook。
- 回放 review gate 时不能重复创建 `ReviewAgentComment`，也不能重复发送同一个 Slack 稳定消息；Slack 状态卡片可以更新到最新阶段。
- 如果同一个 PR 被不同 job 复用，必须优先按 `head_sha` 选择 job；没有 head SHA 时选择当前 active job，并记录 audit 风险。

## Implementation Order

1. Add allowlist config and matcher. Done in MVP.
2. Persist `GitHubWebhookDelivery` first. Done in MVP.
3. Normalize `pull_request_review_comment`. Done in MVP.
4. Normalize `pull_request_review` summary. Done in MVP.
5. Normalize `issue_comment` on PR. Done in MVP.
6. Normalize `check_run` output if Greptile uses checks. Basic MVP support exists; annotation-level records are later.
7. Add classification rules. Done in MVP with conservative rules.
8. Add debounce queue for blocking comments. Next.
9. Trigger `pages-agent.yml(mode=fix)`. Next.
10. Add Slack / issue / PR progress messages. Next.
