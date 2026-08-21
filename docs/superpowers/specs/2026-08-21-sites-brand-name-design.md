# Console 品牌名称常量设计

## 背景

`apps/pages-console` 当前在 TopNav、登录页、管理员权限提示和 HTML title 等用户可见位置直接写入 `XD Cell`，没有统一的品牌名称常量。品牌展示需要统一调整为 `Sites`，并让后续修改只依赖一个语义明确的定义。

## 目标

- 在 Console UI 内定义语义明确的品牌名称常量 `BRAND_NAME`，值为 `Sites`。
- 所有 Console 用户可见的品牌名称展示统一引用该常量。
- 浏览器页面标题也由该常量设置。
- 保持改动局限于展示层，不修改 API、CLI、Worker 名称、域名、协议 header、图形标记或历史文档中的技术标识。

## 设计

在 `apps/pages-console/src/ui/brand.js` 导出：

```js
export const BRAND_NAME = 'Sites';
```

Console 中承担品牌展示的 React 组件直接导入 `BRAND_NAME`。`index.html` 移除现有的静态 `XD Cell` title，UI 入口在 React 渲染前执行 `document.title = BRAND_NAME`，使运行时展示不再依赖独立的品牌字符串。

本次覆盖以下用户可见位置：

- TopNav 品牌名称。
- 登录页和管理员访问状态页的品牌 eyebrow。
- Console 内用户可见的请求失败兜底文案。
- 浏览器页面标题。

`XD` 品牌图形标记保持不变；它不是本次要求的品牌名称文本。Webhook 默认模板会被提交和持久化，不属于纯展示文案，因此保持现状。`XD Cell` 在 API、CLI、认证 Worker、router、文档和测试 fixture 中仍可能作为现有技术或产品标识出现，不在本次 Console 展示调整范围内。

## 测试

- 增加聚焦测试，断言 `BRAND_NAME` 为 `Sites`。
- 断言 Console 的品牌展示位置引用 `BRAND_NAME`，避免再次散落硬编码品牌名。
- 断言 `index.html` 不再包含旧品牌 title，且 UI 入口在渲染前用 `BRAND_NAME` 设置 `document.title`。
- 运行 pages-console 相关测试和 lint；若聚焦命令不可用，则运行仓库现有对应测试入口。

## 风险与回滚

风险仅限 Console 展示文案。若需要回滚，只需恢复展示引用并移除 `brand.js`；不会影响认证、API 合约、数据模型或部署资源。
