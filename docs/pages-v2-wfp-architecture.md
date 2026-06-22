# XD Pages 多租户执行平台架构设计

## 状态

本文是 XD Pages 架构文档索引。原单体设计文档已按主题拆分，以控制单篇文档长度并明确真相源边界。

## 阅读顺序

1. [架构总览](./architecture/xd-pages-overview.md)
2. [资源与部署](./operations/resources-and-deployment.md)
3. [数据模型](./architecture/data-model.md)
4. [一致性与状态机](./operations/consistency-and-state.md)
5. [路由与访问边界](./security/routing-and-access.md)
6. [发布与运行时模型](./architecture/publishing-and-runtime.md)
7. [审计、监控与上线阶段](./operations/observability-and-rollout.md)

## 文档维护规则

- 根索引只放导航和维护规则，不承载长篇正文。
- 每篇主题文档应尽量控制在可 review 的长度内；继续膨胀时优先拆分子主题并从本索引链接。
- 配置、部署、资源、smoke checklist 放在 `docs/operations/`。
- 用户可见模型、组件边界和运行时模型放在 `docs/architecture/`。
- 认证、路由门禁、header/cookie 清洗和敏感信息边界放在 `docs/security/`。
- 历史决策继续放在 `docs/adr/`，不要把运行手册塞回 ADR。
