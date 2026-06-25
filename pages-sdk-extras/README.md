# pages-sdk-extras

本目录暂存从旧 `apps/pages-sdk` 移出的非公开 SDK 草案代码，包括 browser helper、runtime adapter 和 inline runtime source。

当前公开方向是独立 `apps/worker-sdk` / `@xd-cell/worker-sdk`，只面向业务自定义 Worker runtime helper。本目录不是 workspace package，不进入 `pnpm --filter @xd-cell/worker-sdk build`，也不作为 skill 内置 SDK helper 的发布面。

后续如果要恢复 browser helper、adapter 或 inline runtime source，应先重新评估：

- 是否应该成为独立包、skill 生成模板，还是平台内部工具；
- 是否需要独立 README、类型声明、测试和 `BREAKING_CHANGES.md`；
- 是否会扩大业务侧 npm API 面；
- 是否会暴露 runtime endpoint、capability、header 或 gateway 细节。

本目录代码保留历史上下文，不代表当前推荐用法。
