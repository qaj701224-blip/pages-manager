# Site Check

## 定位

`site-check` 是员工站点自动 PR 的确定性安全和构建门禁。它不是 Slack Agent，也不是 Coding Agent，更不是 GitHub Review Agent。

它回答一个问题：

```text
这个 PR 是否只在被授权的员工站点目录内，生成了一个可以构建、没有 secret、符合站点规范的 preview candidate？
```

MVP 形态：

```text
packages/site-check
  ↓
.github/workflows/site-check.yml
  ↓
GitHub required check
  ↓
gateway 持久化 SiteCheckRun
  ↓
Preview Gate
```

后续启用 K8s executor 时，同一个 `packages/site-check` CLI 可以被 `site-check` K8s Job 复用，不能重新写一套规则。

## 组件边界

`packages/site-check` 负责：

- 读取 PR diff、目标 `allowedPath`、`site.json` 和站点源码。
- 校验 PR 是否只修改一个 `sites/<employeeSlug>/<siteSlug>/`。
- 校验 PR body 中的 `PublishingJob`、`Target`、`Allowed path`、`Requester` marker。
- 校验 `allowedPath` 与 DB 中 `PublishingJob` / `SiteProject` 记录一致。
- 校验站点 schema、文件大小、禁止目录、secret scan、lint/test/build。
- 输出稳定 JSON report，供 GitHub check、gateway callback 和排障使用。

`site-check` 禁止：

- 创建 issue、branch、commit、PR。
- merge PR。
- 部署 preview 或 production。
- 持有 Slack bot token、Cloudflare production token、GitHub push token。
- 执行 PR 中不可信脚本时使用高权限 secret。

## 输入

`site-check.yml` 最少输入：

```json
{
  "repoFullName": "xindong/pages-manager",
  "prNumber": 123,
  "baseSha": "base...",
  "headSha": "head...",
  "publishingJobId": "job_...",
  "siteProjectId": "site_...",
  "employeeSlug": "smoke",
  "siteSlug": "profile",
  "allowedPath": "sites/smoke/profile"
}
```

`publishingJobId`、`siteProjectId` 和 `allowedPath` 可以从 PR body marker 解析，但最终必须以 gateway / DB 校验结果为准。

## 必跑检查

| Check | 说明 |
| --- | --- |
| `pages-site-policy` | job、site、actor、owner scope、PR base、approval mode 与 DB 一致 |
| `path-allowlist` | diff 只能包含 `allowedPath/**` |
| `platform-path-block` | 禁止修改 `apps/**`、`packages/**`、`.github/**`、`k8s/**`、`templates/**`、`scripts/**` |
| `single-site-scope` | 一个 PR 只能修改一个员工的一个站点 |
| `site-schema` | `site.json` 合法，slug / title / template / access mode 符合规则 |
| `secret-scan` | 不允许 token、private key、cookie、`.env` 明文进入 PR |
| `file-policy` | 禁止 `dist/**`、`node_modules/**`、缓存、构建产物、大文件和越界 symlink |
| `build` | 使用 page-kit 或站点模板执行 lint / test / build |

`pages-agent.yml` 在创建 PR 前可以运行同一套 precheck，但 Preview Gate 不能只相信 precheck。PR 创建后必须由 `site-check.yml` 在 PR head SHA 上重新跑。

## 输出

`packages/site-check` 输出 JSON：

```json
{
  "status": "passed",
  "repoFullName": "xindong/pages-manager",
  "prNumber": 123,
  "headSha": "head...",
  "publishingJobId": "job_...",
  "siteProjectId": "site_...",
  "allowedPath": "sites/smoke/profile",
  "checks": {
    "pagesSitePolicy": "passed",
    "pathAllowlist": "passed",
    "siteSchema": "passed",
    "secretScan": "passed",
    "filePolicy": "passed",
    "build": "passed"
  },
  "changedFiles": [
    "sites/smoke/profile/site.json",
    "sites/smoke/profile/src/index.html"
  ],
  "errorCode": null,
  "errorMessage": null
}
```

gateway 持久化为 `SiteCheckRun`。如果 gateway 暂时不可用，GitHub check 可以先失败并给出可重试错误；不能因为持久化失败而让 Preview Gate 放行。

## Preview Gate 合同

进入 Preview 前必须同时满足：

```text
site-check = passed
pages-site-policy = passed
PR head SHA == SiteCheckRun.head_sha
PR only touches allowedPath
no open blocking ReviewAgentComment
no open unknown ReviewAgentComment
no active pages-agent fix round
```

GitHub Review Agent 只负责语义/质量 review；`site-check` 负责确定性隔离和构建。二者都通过，Preview 才能自动部署。

## 与 Slack Agent / Coding Agent 的关系

- Slack Agent 可以读取 `SiteCheckRun` 摘要，用于向用户解释为什么失败。
- Coding Agent 可以读取 failed `SiteCheckRun` report，作为 fix round 输入。
- Slack Agent 不能修改 site-check 规则。
- Coding Agent 不能修改 `packages/site-check`、`.github/workflows/site-check.yml` 或其它平台代码来让自己过关。

## MVP 实现顺序

1. 新增 `packages/site-check`，先实现 path allowlist、platform path block、PR marker 和 placeholder schema。
2. 新增 `.github/workflows/site-check.yml`，在 `pull_request` 上运行，并作为 required check。
3. gateway 接收 `check_run` webhook，校验 check name / app allowlist 后写入 `SiteCheckRun`。
4. Preview Gate 读取同一 PR head SHA 的 `SiteCheckRun`，并与 Review Agent gate 同时通过后才触发 Preview。
5. 补 secret scan、file policy、lint/test/build。

当前代码已具备第 3、4 步的最小闭环：`site-check` 成功可以回放已保存的 Review Agent 通过结果并触发 Preview；Review Agent 先通过但 `site-check` 缺失时只会在 Slack 中提示等待；`site-check` 失败会暂停 Preview。
