## 动机 / 背景

<!-- 这个 PR 要解决什么问题？为什么现在需要做？ -->

## 改动范围

<!-- 列出主要改动点。保持一个 PR 一个目的，不要混入无关重构。 -->

- 

## 测试路径

<!-- 写清楚 reviewer 可以如何复现/验证。命令、请求、页面、预期结果都尽量具体。 -->

1. 
2. 
3. 预期结果：

## 风险与回滚

<!-- 说明可能影响的部署/API/站点范围，以及出问题时如何回滚。无风险也请说明原因。 -->

## Cloudflare / 部署检查

<!-- 不涉及的项写 N/A + 简短理由。 -->

- staging / production Worker、KV、route、domain 是否隔离：
- 是否影响 `Deploy Staging`：
- 是否影响手动 `Deploy Production`：
- 是否新增或变更 GitHub secrets / vars：
- 是否新增或变更 Worker secrets：

## API / 文档检查

<!-- 不涉及的项写 N/A + 简短理由。 -->

- 是否影响 `/deploy`、`/list`、`/site/:name` 或 token 逻辑：
- 是否影响 `openapi.json`、`skill.md`、`README.md`、`API.md`：
- 是否影响 `pages-deploy.sh` / `pages-manage.sh` 下发脚本：

## Self-review Checklist

- [ ] Title 符合 `<type>(<scope>): <精准中文描述>`，type 在白名单内
- [ ] Title / Description 主体为中文，技术术语、文件名、命令、API 名称保留英文
- [ ] 没有提交 secret、真实 token、真实 `.env` 或本地部署配置
- [ ] 没有在公开响应、日志、文档或测试里泄露用户 token / Cloudflare 资源真实值
- [ ] staging / production 配置没有串环境
- [ ] production 仍然只通过 GitHub Actions 手动部署
- [ ] OpenAPI / skill / README / API.md 与真实行为一致
- [ ] 行为变更已有 focused `node:test` 覆盖
- [ ] 已跑 `pnpm lint`
- [ ] 已跑 `pnpm test`

## 关联信息

<!-- issue / 讨论来源 / 需求来源。没有则写“无”。 -->
