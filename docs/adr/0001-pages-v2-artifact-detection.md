# ADR 0001: XD Cell artifact detection 设计

## 状态

Accepted。

本文是 ADR 0001 的索引页。原单体 ADR 已按主题拆分，以控制单篇文档长度并保留稳定入口。

## 阅读顺序

1. [背景、决策与用户模型](./0001-pages-v2-artifact-detection/context-and-model.md)
2. [自动判断、Preflight 与 JSON 输出](./0001-pages-v2-artifact-detection/detection-and-preflight.md)
3. [API、存储与实施策略](./0001-pages-v2-artifact-detection/api-storage-and-implementation.md)
4. [取舍、测试与参考资料](./0001-pages-v2-artifact-detection/tradeoffs-tests-and-references.md)

## 维护规则

- 本路径只保留 ADR 状态、导航和维护规则。
- 设计事实修改到对应主题文件，不把长篇正文重新塞回索引。
- 用户文档只讲 `source`、`fallback`、`worker.entry`；不要重新引入 `artifactKind`、公开输入 `deploymentShape` 或 `static/spa/worker` 心智。
- API 开发合约以 `apps/pages-api/src/openapi.js` 和对应测试为准；本文记录长期设计取舍，不替代实现合约。
