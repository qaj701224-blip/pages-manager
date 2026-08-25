# pages-console 文档

本文是 `apps/pages-console` 领域内文档入口。控制台前端 UI、交互、组件、验收和评审规范优先维护在本目录；全局 `docs/README.md` 只作为 monorepo 文档索引引用这里。

## 当前规范

- [XD Cell 控制台前端设计规范](./frontend-design-guidelines.md)
- [staging 控制台 UI / 交互走查](../../../docs/reviews/staging-workers-ui-audit-2026-07-03.md)

当前站点设置支持分别保存展示名称与 canonical URL。名称可清空并回退显示 slug；URL 改名后旧地址停止访问，在旧 pointer 清理和安全期结束后释放，pending 状态由详情页轮询至 ready。Workspace 与 Admin 使用同一服务端 metadata use case。运行配置保存后保留当前列表并后台刷新，页面为弹窗滚动锁预留稳定滚动条槽。缩略图上传与托管延期，当前 UI 不展示占位入口。
