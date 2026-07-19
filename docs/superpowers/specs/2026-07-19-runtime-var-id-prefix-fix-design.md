# Runtime Var ID Prefix 修复设计

## 背景

公网 `PUT /.xd-pages/api/sites/{site}/vars` 把 binding name 清洗后拼进 `newId()` 的 prefix。`newId()` 只接受 2 到 16 位小写字母数字，因此常见的长变量名会在 D1 revision 查询完成后、INSERT statement 构造前抛错，最终返回 `503 RUNTIME_CONFIG_UNSUPPORTED`。现有诊断阶段仍停留在 `revision_read`，导致日志误导排查方向。

`PUT /.xd-pages/api/sites/{site}/secrets` 使用固定的 `sec` ID prefix，不受该问题影响。

## 方案

- vars handler 不再根据 binding name 生成记录 ID，让 `D1PagesStore` 使用已有的固定 `var` prefix。
- 在 vars 和 secrets 的 revision 查询完成后切换到新的 `statement_build` 诊断阶段，再进行 quota 校验和 D1 statement 构造。
- 不改变公开 API 请求、响应、鉴权、revision 或 provider 同步语义。

未采用在 handler 中清洗、截断 binding name 的方案，因为记录 ID 已有随机后缀，不需要把业务名编码到 prefix 中；继续保留这层映射只会增加长度和字符集边界。

## 测试

- 增加公网 vars 回归测试，使用与 staging 复现一致的长变量名，并让 store 执行 handler 提供的 ID factory；修复前应返回 503，修复后应成功。
- 增加 D1 store 诊断测试，断言 revision 查询之后的同步 statement 构造错误标记为 `statement_build`。
- 增加 audited secret 对应测试，确保相同窗口也使用 `statement_build`。
- 运行 focused tests、完整 `pnpm test`、`pnpm lint` 和 `git diff --check`。

## 风险与回滚

风险仅限新建 `site_vars.id` 的随机 prefix 从变量名派生值统一为 `var`；ID 不属于公开 API 合约，也没有业务查询依赖 prefix。回滚时恢复 handler 的 `createId` callback 并移除 `statement_build` 枚举与测试。
