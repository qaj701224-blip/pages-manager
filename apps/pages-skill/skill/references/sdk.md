# XD Pages SDK

SDK 用法以 `tools/pages-sdk` 内置包为准。不要在 skill 文档里复刻 SDK 示例或函数签名；接入前先读取 SDK 自己的文档和导出表。

不要优先使用用户项目里的 SDK 文档；当前 skill 内置 README 和 package exports 才是本次会话的权威来源。

## 权威来源

先读 SDK README：

```bash
sed -n '1,220p' tools/pages-sdk/README.md
```

再检查 package exports：

```bash
node -e "const pkg=require('./tools/pages-sdk/package.json'); console.log(JSON.stringify(pkg.exports, null, 2))"
```

## 接入判断

- 浏览器代码需要调用 XD Pages runtime API 时，按 SDK README 的 Browser 部分接入。
- Worker 代码需要读取平台上下文或使用 runtime helper 时，按 SDK README 的 Worker 部分接入。
- 自定义 Worker 只有在明确需要暴露 browser runtime endpoint 时，才参考 SDK README 的 Runtime Adapter 部分。
- 不要猜 import path、函数名或参数。以 `package.json.exports` 和 README 为准。

## 边界原则

- Runtime service binding 凭证必须放在 Worker bindings 和 secrets 中，不要写入源码文件。
- 自定义 Worker 代码不能信任浏览器传入的平台相关 header；需要平台上下文时按 SDK README 的 Worker 用法接入。
- 如果 README、exports 和用户需求不一致，先以当前 SDK 产物为准，再决定是否需要更新 SDK 源码。
