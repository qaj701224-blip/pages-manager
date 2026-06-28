# XD Cell Deploy CLI Design

## 背景

`xd-cell` 是 XD Cell v2 的用户入口。当前 `deploy` 命令已经支持发布静态资源、Worker 和 Worker with assets，但命令形态仍偏平台内部模型：`xd-cell deploy <目录> <站点名>`、旧配置文件字段较直接暴露 CLI 实现细节。

本设计收敛一版新的 `xd-cell deploy` 用户契约：功能和交互设计吸收 `wrangler deploy` 的直觉，例如一个发布入口、配置文件描述发布模板、本地预演和 runtime 变量；但对外不宣传“Wrangler 子集”，也不把 Cloudflare 资源管理心智暴露给普通用户。`xd-cell deploy` 始终是 XD Cell 的业务站点发布命令。

## 目标

- 固定清晰的 deploy 位置参数，避免 `entry` 与 `site` 歧义。
- 让 `xd-cell.config.json` 成为发布模板，而不是内部参数清单。
- 默认面向 production 发布，不向普通用户暴露 staging / production 环境切换心智。
- 支持配置文件内的非敏感 runtime vars，满足 Worker runtime 的普通配置需求。
- 增加站点级 `secrets put/delete` 命令；secret value 不进入 deploy 参数、配置文件、日志或响应。
- 保持 Cloudflare route、domain、account、zone、token、bindings 等平台资源由 XD Cell 托管。

## 非目标

- 不对外宣传 `xd-cell deploy` 是 `wrangler deploy` 的子集。
- 不在第一版支持 `xd-cell deploy <site>` 短写。
- 不公开 `--env production|staging` 作为普通 deploy 心智。
- 不支持用户配置 Cloudflare route、domain、account、zone、dispatch namespace 或 API token。
- 不支持 D1、KV namespace、Queues、Durable Objects 等通用 bindings 声明。
- 不支持 TypeScript bundling、minify、define、outdir。
- 不支持 per-deploy compatibility date / flags。兼容日期仍由平台控制。
- 第一版不支持 `vars put/delete/list`；非敏感 vars 推荐在 `xd-cell.config.json` 这类发布模板中声明。
- 不支持普通用户可用的 `secrets list`，避免泄露 runtime 配置名称这类敏感元信息。
- 第一版 CLI 不公开回滚命令。版本回滚能力仍可作为 pages-api 内部能力保留，但不进入普通用户 CLI 心智。

## 命令契约

主路径仍推荐两个位置参数，但支持从当前目录发布模板补齐：

```bash
xd-cell deploy <entry> <site> [options]
xd-cell deploy [entry] [options]
xd-cell deploy --config <file> [options]
```

示例：

```bash
xd-cell deploy ./dist demo
xd-cell deploy . demo
xd-cell deploy ./src/index.js demo
xd-cell deploy ./src/index.js demo --assets ./dist

# 当前目录 xd-cell.config.json 提供 name 和入口时
xd-cell deploy

# 当前目录 xd-cell.config.json 提供 name 时，位置参数覆盖入口
xd-cell deploy ./dist

xd-cell deploy --config xd-cell.config.json
```

语义：

- `<entry>` 是静态资源目录或 Worker JS / MJS 入口文件；可以由位置参数提供，也可以由配置文件的 `main` / `assets.directory` 提供。
- `<site>` 是业务站点名，也是站点归属、访问策略、路由、审计和 token scope 的边界；它在有效 deploy 配置中必不可少，可以由位置参数提供，也可以由配置文件的 `name` 提供。
- `--config <file>` 可以提供缺失的位置参数；命令行和配置文件合并后的有效 deploy 配置必须提供业务站点名和发布入口。
- 未显式传 `--config <file>` 时，CLI 可以自动读取当前工作目录的 `xd-cell.config.json`。
- 第一版自动发现只查当前工作目录，不向父目录递归查找，避免在 monorepo / 多站点目录中误用父级配置。
- 不兼容旧 `pages.config.json` 作为新心智入口；新 help / docs / skill / llms 只主推 `xd-cell.config.json`。
- 不自动读取 `pages.config.json`，也不把旧字段映射为新模板字段。
- 参数优先级固定为：命令行位置参数 / flags > 显式 `--config <file>` > 当前目录自动发现的 `xd-cell.config.json`。
- 显式 `--config <file>` 不与自动发现的配置合并。
- 单个位置参数永远按 `<entry>` 解释，不按 `<site>` 解释。`xd-cell deploy demo` 不会被当成发布站点 `demo`。
- 如果缺少 site 或入口，应报出可操作错误，提示使用 `xd-cell deploy <entry> <site>`，或在当前目录 `xd-cell.config.json` / 显式 `--config <file>` 中配置 `name` 和发布入口。

公开选项第一版包含：

```txt
--assets <dir>                             Worker 发布时附带静态资源目录。
--visibility <internal|org|acl|owner|disabled>
                                           创建站点时的初始访问范围；默认 org。
--dry-run                                  只做本地检测和打包，不创建站点、不上传。
--token <token>                            只在本次命令中使用的 API token，会覆盖本次命令凭证；建议优先使用 login 或 XD_CELL_API_TOKEN。
--config <file>                            读取发布模板。
--json                                     输出稳定 JSON。
--help                                     显示帮助。
```

`--env` 可以作为内部兼容能力保留，但不出现在普通用户 deploy help 的主路径中。普通用户默认 production。staging smoke、维护验证和 agent 内部测试流程只在 CLI 领域 internal llms / maintainer docs 中说明，不进入普通用户 help、public llms 或 `apps/pages-skill`。

CLI 也应支持从环境变量读取 token。用户可以手动设置 `XD_CELL_API_TOKEN`，这样无需先运行 `xd-cell login`，也无需每次显式传 `--token`：

```bash
export XD_CELL_API_TOKEN=<token>
xd-cell deploy ./dist demo --json
xd-cell status demo --json
```

也可以只对单次命令生效：

```bash
XD_CELL_API_TOKEN=<token> xd-cell deploy ./dist demo --json
```

凭证优先级：

1. `--token <token>`：显式命令行参数，最高优先级，只建议用于短期受控场景。
2. `XD_CELL_API_TOKEN`：当前 shell / 进程环境中的 token。
3. 本地 secret store 中的登录凭证。

`XD_CELL_API_TOKEN` 是无状态凭证来源，不写入本地 profile / secret store，不进入 deploy metadata、配置文件、日志、JSON 输出或错误详情。它只被需要访问 API 的命令读取；`help`、`version`、`detect`、`deploy --dry-run` 等本地命令应忽略该环境变量，不因为它存在而报错。既有 `PAGES_ACCESS_KEY` 可以作为 hidden legacy 兼容保留，但新 help / llms / skill 只主推 `XD_CELL_API_TOKEN` 和 `--token`。

实现上，`--token <token>` 和 `XD_CELL_API_TOKEN` 都不应在 CLI 本地被强行归类为“发布 access key”。它们可能是用户 CLI token，也可能是站点级 access key；CLI 应作为 bearer credential 发送，由 pages-api 的 `whoami` / auth 结果判定 actor 类型和权限。这样可以避免 deploy 因本地误判为 access key 而跳过“创建站点”流程，也避免把用户 token 的能力降级成站点发布 token。旧脚本使用的 `PAGES_ACCESS_KEY` 可以继续按 hidden access key 兼容，但不进入新用户心智。

deploy 创建站点的判定也应跟随 actor 类型，而不是本地 token 来源：用户 CLI token 可尝试创建站点；站点级 access key 不能创建站点，只能发布其 scope 内已有站点。若无法提前判定 actor，CLI 可以先调用 `whoami`，或在创建站点遇到明确权限拒绝时跳过创建并继续发布已有站点，但不能把其它创建失败吞掉。

命令边界：

- 会使用 `XD_CELL_API_TOKEN` 的命令：`deploy` 非 dry-run、`status <site>`、`status --deployment <id>`、`whoami`、`sites`、`open`、`access`、`secrets put/delete` 等需要访问 pages-api 的命令。
- 不应使用 `XD_CELL_API_TOKEN` 的命令：`login`、`logout`、`auth logout`、`auth status`、无 site / deployment 参数的本地 `status`、`help`、`version`、`detect`、`deploy --dry-run` 等本地或只读本地状态的命令。
- `auth status` 只报告本地登录凭证状态，不把 `XD_CELL_API_TOKEN` 视为已登录。
- `whoami` 是验证 `XD_CELL_API_TOKEN` 是否可用的推荐命令。

缺少凭证时，错误提示应优先引导不会进入 shell history 的路径：

```txt
请先运行 xd-cell login，或设置 XD_CELL_API_TOKEN；短期受控场景也可以传 --token <token>。
```

## 发布模板

`xd-cell.config.json` 应贴近发布模板设计。模板使用非敏感字段，禁止保存 token、cookie、secret、Cloudflare 资源 ID 或其它凭证。

静态资源站点：

```json
{
  "name": "demo",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  },
  "visibility": "org"
}
```

Worker-only：

```json
{
  "name": "demo",
  "main": "./src/index.js",
  "vars": {
    "FEATURE_FLAG": "true"
  },
  "visibility": "owner"
}
```

Worker with assets：

```json
{
  "name": "demo",
  "main": "./src/index.js",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  },
  "vars": {
    "API_BASE": "https://api.example.com"
  },
  "visibility": "org"
}
```

字段说明：

- `name`：业务站点名。
- `main`：Worker JS / MJS 入口。
- `assets.directory`：静态资源目录。
- `assets.not_found_handling`：静态资源未命中时的行为，贴近 Wrangler 命名，可选 `none`、`single-page-application`、`404-page`，默认 `none`。
- `vars`：非敏感 runtime 配置键值对，会作为 Worker plain text env 注入。
- `visibility`：XD Cell 访问策略，是平台扩展字段。

命令行优先级高于配置文件。例如命令行 `<entry>` 和 `<site>` 会覆盖 `main` / `assets.directory` 与 `name`。

配置文件路径语义：

- `xd-cell.config.json` 内的 `main`、`assets.directory` 等相对路径以配置文件所在目录为基准。
- 当前目录自动发现时，配置文件所在目录就是当前工作目录。
- 显式 `--config <file>` 指向其它目录时，仍以该配置文件所在目录解析相对路径，而不是命令执行目录。
- 非 `--json` 输出可以提示 `Using config: ./xd-cell.config.json`；`--json` 输出可以包含 `configPath`，使用相对当前工作目录的规范化路径，例如 `xd-cell.config.json` 或 `subdir/xd-cell.config.json`，但不得包含 token、secret value 或其它敏感信息。

配置校验采用 clean break，不兼容旧字段：

- 只允许 `name`、`main`、`assets.directory`、`assets.not_found_handling`、`vars`、`visibility`。
- 不接受 `site`、`source`、`dir`、`worker.entry`、`assets.fallback`、`env`、`secrets` 等旧字段或别名。
- `vars` 只能是字符串键值对象，key 必须是合法 binding name，value 必须是字符串。
- 新模板不接受 `environment` 字段；目标环境来自 CLI 发行渠道、本地 profile 或受控维护流程。新 help / public llms / pages-skill 不展示环境字段。
- 配置文件递归拒绝 secret-like 字段名和值字段名；secret 不进入配置文件，使用 `xd-cell secrets put <site> <name>` 管理。
- 第一版不提供 `--fallback` 命令行别名；静态资源未命中行为只通过 `assets.not_found_handling` 配置，避免同一概念出现两套入口。

## Runtime Vars

`vars` 用于非敏感明文 runtime 配置，贴近 Wrangler 的 `vars` 心智：它是 deploy 配置的一部分，`deploy` 时把本次解析出的有效配置上传为当前 Worker 版本的 plain text bindings。

这里的“有效配置”来自显式 `--config`、命令行覆盖项，以及未来可能的受控生成配置。`xd-cell.config.json` 是推荐发布模板，但不应写成唯一绝对真相源；真正参与发布的是 CLI 在本次命令中解析出的 deploy config snapshot。

第一版不做 `xd-cell vars put/delete/list`。`site_vars` 是平台内部站点级当前 runtime config store，唯一用户入口仍是 deploy 配置，避免同时存在“发布模板写 value”和“远端 vars 命令”两套入口。

语义：

- 当前版本 Worker 读取的是发布该版本时物化的 vars。
- Worker deploy 中显式提供 `vars` 时，pages-api 将其同步为该站点当前 runtime vars；显式 `{}` 表示清空。
- Worker deploy 省略 `vars` 字段时，为兼容旧 CLI 和避免误清空，pages-api 沿用该站点当前 runtime vars。
- 新版本不应因为 Worker slot 复用而继承其它站点或其它版本的残留 bindings；上传时必须使用站点级有效 runtime config 的完整 bindings。
- 与 secrets 不同，deploy 不会删除站点级 secret store 中的 secret value。

与 Wrangler 对齐的边界：

- 配置文件是推荐的 Worker 配置来源，但不是对外承诺的唯一来源；构建工具、CI 或未来受控流程可以生成本次 deploy 使用的有效配置。
- 第一版不暴露 `keep-vars` 之类额外选项；平台内部必须保证本次 Worker upload 使用完整 bindings，避免旧 slot 残留。
- 如果未来需要支持“保留远端已有 vars”这类能力，应单独设计显式选项，并重新评审它与站点级权限、审计和 slot 清理的关系。

约束：

- key 必须是合法 Worker binding name，例如 `API_BASE`。
- value 只允许字符串。
- 禁止疑似敏感 key，例如包含 `token`、`secret`、`password`、`credential`、`cookie`、`private_key` 等片段。
- `xd-cell.config.json` 中的 `vars` 必须执行同一疑似敏感 key 校验，避免把敏感项作为 plain text env 注入。
- key 不能使用平台保留名、保留前缀或与其它 binding 冲突。第一版应至少保留 `XD_`、`XD_CELL_`、`XD_PAGES_`、`CF_`、`ASSETS`、平台 service binding 名称、assets binding 名称和未来 capability binding 名称。
- 同一版本内 vars、secret、assets binding、service binding 之间不能重名；冲突必须 fail closed，不能用用户声明覆盖平台 binding。
- 输出、错误、日志和审计中不打印完整 value；需要引用名称时使用受控 name 或带平台 pepper/HMAC 的 name 摘要。
- deploy 的显式 `vars` 对象决定本次同步后的站点级 plain text env 集合；省略时使用站点当前集合。
- Worker deploy 中显式提供的 `vars` 必须进入 deployment request hash；省略 `vars` 时沿用的站点级当前配置不进入 request hash。artifact `contentHash` 不包含 `vars`。

部署时，CLI 仅在配置中显式声明 `vars` 时把它作为 metadata value 传给 pages-api；pages-api 必须重复校验、同步站点级 `site_vars`，再转成 Worker plain text bindings，由平台上传到实际执行 provider。`vars` value 不写入日志、错误、聊天、截图或公开响应。

第一版仅 Worker-only 和 Worker with assets 会注入 runtime bindings。assets-only 发布中出现 `vars` 时不失败，但本次发布忽略 `vars`：不注入、不同步、不清空站点级 vars。

## Secrets

`secrets` 与 runtime vars 分开管理。配置文件不声明 secret 名称，也不保存 secret value。secret 的入口只使用 CLI 命令：

第一版命令：

```bash
xd-cell secrets put <site> <name>
xd-cell secrets delete <site> <name>
```

输入方式：

```bash
xd-cell secrets put demo API_TOKEN
```

交互输入 secret value，隐藏回显。

```bash
echo "$API_TOKEN" | xd-cell secrets put demo API_TOKEN --stdin
```

CI 使用 stdin 输入。命令不支持把 secret value 放在位置参数中，避免进入 shell history。

不支持普通用户枚举某个站点的 secret 名称。

原因：

- secret 名称本身可能泄露业务依赖和攻击面；runtime binding 名称也可能暴露内部服务或能力边界。
- 普通 deploy 不需要枚举远端 runtime 配置。
- 第一版少一个读接口，安全边界和审计更简单。

`secrets delete` 应避免被用于枚举。对不存在的 secret，可以返回幂等成功或模糊提示，不暴露“是否存在”的精确信息。

第一版仅 Worker-only 和 Worker with assets deploy 会注入 secrets。assets-only deploy 不读取、不注入站点级 secret store。

`xd-cell secrets put <site> <name>` 设置的是站点级 secret store，不是单次 deploy metadata。secret value 可以跨部署保留。第一版不把 secret name 放进 `xd-cell.config.json`；secret 是否暴露给 Worker 由站点级 secret binding 状态决定。

语义要求：

- `secrets put` 只保存或更新站点级 secret value，不修改任何现有版本的 Worker bindings。
- `secrets delete` 删除或禁用站点级 secret value，不直接改写已经上传的历史 Worker；后续 Worker deploy 不再注入该 secret。
- `secrets delete` 的第一版语义是“阻止未来重新物化或新 deploy 使用该 secret”，不是撤销正在运行 Worker 内已经物化的 secret value。CLI 删除成功提示必须明确这一点，并建议需要立即撤销时重新设置上游 secret / token，或重新 deploy 一个不依赖该 secret 的版本。
- `secrets put` 后，该 secret 默认作为站点级 Worker secret binding 对后续 Worker deploy 可用。
- Worker deploy 默认注入该站点当前启用的 secrets；不需要在 `xd-cell.config.json` 中声明 secret name。
- 现有内部 rollback 如果只是重新激活仍可用的历史 Worker / slot，不重新注入 runtime config；该 Worker 按当时物化后的 bindings 运行。
- 内部重新物化历史版本时，只能注入该版本记录中物化过的 secret 名称，并使用该版本允许的 runtime config revision；缺失、已删除或 revision 不允许时应 fail closed。

runtime vars 和 secrets 采用不同入口：vars 由本次 deploy 解析出的有效 config snapshot（显式 `--config`、命令行覆盖项、受控生成配置等）同步为站点级当前 runtime config，secrets 来自站点级 secret store。site version 保存本版本最终物化的 vars name 集合、secret binding name 集合和内部 runtime config snapshot（var name/value/revision、secret name/revision/valueHash）；公开响应不返回这些绑定明细。secret valueHash 必须使用平台 pepper/HMAC，不得是明文、裸 digest 或可用于恢复 secret 的材料。

第一版权限模型保持简单：站点发布权限就是设置该站点 vars / secrets 的权限边界。

- 用户 CLI token 作为站点 owner 时，可以 deploy、通过 deploy 配置设置 vars、`secrets put/delete`。
- 站点 owner 可以创建站点级 deploy-capable access key / publish token；该凭证如果能发布该站点，也可以为该站点 `secrets put/delete`，并在 deploy 时使用该站点当前启用的 secrets。
- 非 owner 的站点 member / viewer 不能为站点创建 deploy / rollback access key，避免只读成员把自身权限提升为发布权限。
- token scope 必须限制在站点边界内；可以发布 `demo` 的凭证不能设置或读取其它站点的 secrets。
- 只有只读 / status 权限的凭证不能 `secrets put/delete`。
- 发布权限是高信任权限，因为具备发布 Worker 代码的人天然可以读取被注入到该站点 Worker 的 secrets。CLI 和 access key 创建文案需要明确这一点，而不是再拆 `use:secrets`、`manage:secrets`、name allowlist 等第一版 scope。

## Deploy 与 Runtime Config 的交互

当 `xd-cell.config.json` 声明：

```json
{
  "name": "demo",
  "main": "./src/index.js",
  "vars": {
    "API_BASE": "https://api.example.com"
  }
}
```

`deploy` 会把显式配置的 `vars` 同步为站点级当前 runtime vars，并作为本次版本的 plain text runtime bindings 上传。配置省略 `vars` 时沿用站点当前 runtime vars；显式 `{}` 会在下一次 Worker deploy 清空。secret 不在配置文件中声明；如果站点已通过 `xd-cell secrets put demo API_TOKEN` 设置 secret，pages-api 会在 Worker deploy 时把该站点当前启用的 secrets 作为站点级 secret bindings 注入。

如果当前 actor 没有该站点发布权限，deploy 和 `secrets put/delete` 都应返回权限不足。错误不需要区分“没有使用某个 secret 的权限”和“secret 不存在”，因为第一版没有独立的 secret 使用 scope。

CLI 上传 multipart metadata 时新增声明字段，仍保持 `schemaVersion: 1` additive 扩展：

```json
{
  "schemaVersion": 1,
  "siteSlug": "demo",
  "contentHash": "sha256:...",
  "publishPlan": {},
  "vars": {
    "API_BASE": "https://api.example.com"
  }
}
```

`vars` 是非敏感 plain text runtime 配置，允许携带 value，但不得进入日志、错误和公开响应。CLI 应对 key 做去重、排序和合法性校验；pages-api 必须重复校验，不能信任客户端。老 CLI 缺省字段按“沿用站点当前值”处理，避免误清空。

部署 Worker 时：

- `vars` 注入为 plain text bindings。
- 该站点当前启用的 secrets 注入为 secret bindings 或平台 provider 支持的等价机制。
- deploy response 和 JSON 输出不返回 vars value 或 secret value。
- 日志、审计和错误不记录 vars value 或 secret value。
- 如果 provider upload 成功但后续 version / route / snapshot 写入失败，平台必须尽力删除或清理刚上传且包含 runtime bindings 的 Worker / slot。清理失败时该执行资源不能被其它站点复用，必须进入不可分配或待人工清理状态。

如果现有 WFP 上传路径不能直接引用已存 secret，则需要设计平台侧密文存储或 provider 侧 secret 管理。密文不得以明文落 D1、KV、日志或测试 fixture。

## API 与存储边界

需要新增受控 API：

```http
PUT    /.xd-pages/api/sites/{site}/secrets
DELETE /.xd-pages/api/sites/{site}/secrets
```

请求体建议使用 JSON，name 和 value 都放 body，不放 URL：

```json
{
  "name": "API_TOKEN",
  "value": "<secret>"
}
```

`--stdin` 场景由 CLI 读取 stdin 后放入 `value` 字段。CLI 和 API 都不得在错误或调试输出中回显 `value`。

不新增普通用户可用的 secrets list API。

API 要求：

- 需要认证和站点发布权限校验。
- secret name 和 value 只从请求体读取，不放在 URL path、query string、响应、日志或错误中。
- 响应不返回 value。
- 错误和审计不包含 value。
- secret name 校验应与 Worker binding 变量名兼容。
- secret name 需要在站点内归一化去重；同一版本重复 name 应在 CLI 或 API 层拒绝或归一化为唯一集合。
- put / delete 行为要有审计记录，但审计只记录 site、name HMAC 或受控 name、actor、时间和操作，不记录 value。
- 需要定义并校验配额：单个 value 字节数、单站点 runtime config key 数、单次 deploy binding 数、请求体大小和 provider metadata 限制。超限错误应可操作但不回显 value。
- 第一版 runtime binding 配额采用保守固定上限：单个 var / secret value 不超过 8 KiB，单站点启用 secrets 不超过 64，单次 Worker deploy 的 vars + secrets 总 binding 数不超过 64。后续如 provider 限制变化，可在 pages-api 内部调整并保持错误码语义稳定。

权限上，`secrets put/delete` 直接绑定站点发布权限：

- 用户 CLI token 必须是站点 owner 或具备该站点发布权限。
- 站点级 access key / publish token 只能管理自身 scope 内的站点 secrets；deploy-capable key 只能由站点 owner 创建。
- 只读、status、内部观测类 token 不能管理 secrets。
- 旧 token 是否具备发布权限按现有 pages-api actor / scope 判定；本次设计不新增 `use:secrets`、`manage:secrets` 或 name allowlist。
- 产品文案需要提示：发布权限是高信任权限，能上传 Worker 代码，也能设置并使用该站点 secrets。

审计要求：

- put / delete 必须记录 actor 类型、actor id、site id、environment、name HMAC 或受控 name、操作类型、时间和结果。
- secret 审计不得记录 value、value digest、provider secret ref 或任何可用于重放/恢复 secret 的材料。
- vars 审计也不记录 value；即使 vars 是非敏感配置，也按不回显 value 的统一规则处理。
- 失败审计需要区分权限拒绝、name 校验失败、value 存储失败和 provider 同步失败，但错误详情不得包含 value。
- 如果审计记录 name hash，必须使用带平台 pepper/HMAC 的不可枚举摘要，不能使用裸 hash；受控 name 只能在受限内部审计视图展示。
- 如果后续引入 value rotation 或 provider secret ref 轮换，审计只记录 rotation 事件和 key name，不记录旧值/新值摘要。

站点级 secret store 可以使用独立表或 provider 引用，形态示例：

```txt
site_secrets
- id
- environment
- site_id
- name
- encrypted_value 或 provider_ref
- revision
- value_digest
- created_by
- updated_by
- created_at
- updated_at
```

约束：

```txt
unique(environment, site_id, name)
```

这里的 `environment` 是 production / staging 平台隔离维度，不是用户配置的 runtime vars。站点级边界以 `site_id` 为准，runtime value store 不应包含 deployment id 或 version id；版本记录本次物化的 name 集合以及物化时使用的 runtime config revision 集合。

secret value 必须加密存储或只保存 provider 引用，不得以明文落 D1、KV、日志、测试 fixture 或部署响应。

secret 存储细节：

- 如果平台自持密文，必须使用 Worker secret 注入的加密 key 或 Cloudflare 支持的等价密钥管理能力；加密 key 不得写入 D1、KV、wrangler template、GitHub vars 或文档示例。
- ciphertext、iv/nonce、key id 可以入库；plaintext 只能在请求处理和 provider upload 所需的最短生命周期内存在于内存。
- `value_digest` 对 secret 必须是带平台 pepper/HMAC 的不可枚举摘要，不能使用裸 sha256，避免低熵 secret 被离线枚举。
- provider secret ref 如果包含 provider resource id 或可关联底层账号信息，不应进入公开响应、普通审计详情或 CLI JSON 输出。
- 测试 fixture 只能使用假值，并验证日志/错误/响应不包含这些假值。

vars value 来自本次 deploy metadata，不作为站点级远端 store 持久化；无论存入 site version metadata 还是 provider upload payload，都不得进入日志、错误、聊天、截图或公开响应。

vars value 需要参与 deployment request hash 以保证幂等语义，但不能使用裸 sha256。第一版可以使用服务端私有 pepper / HMAC 生成受控摘要，只在 request hash 计算中使用，不进入公开响应或 site version 明细。

site version 必须保存该版本物化的规范化 vars / secret 名称列表，例如 `var_names_json`、`secret_names_json`；不得只保存 hash。这样 deploy、回滚、审计和问题排查都能区分“这个版本暴露了哪些 runtime binding”。如名称本身敏感，公开响应和普通 CLI JSON 仍不返回这些名称；内部受限审计视图可以读取。

同时，site version 应保存非敏感的 runtime config revision 信息，例如 `secret_revisions_json` 或 `runtime_config_revision_hash`。revision 可以是单调递增版本号、随机 revision id 或 provider secret ref 的受控版本标识，但不得是 value 明文、裸 digest 或可用于恢复 secret 的材料。这样可以回答“这个版本物化时使用了哪一代 secret”，同时避免把 secret value 放进版本记录。

deploy 使用 runtime config 时必须在服务端形成原子快照：

- 在同一受控事务或等价一致性窗口内，解析本次 vars，校验 actor 对站点的发布权限，读取该站点当前启用的 secrets value + revision，计算 runtime config revision hash，并保存 site version 的 name/revision 记录。
- Worker upload 必须使用同一快照中的 value，不能在 hash / version 记录后再次读取“当前值”。
- 如果并发 `secrets put/delete` 导致任一 secret 的 revision 在快照过程中变化，deploy 必须 fail closed 或重试整个快照流程。
- 第一版如果暂不引入 D1 强事务快照，可以在读取 secret 后、provider upload 前重新读取 name/revision 集合做一致性校验；不一致时返回 `RUNTIME_CONFIG_CHANGED` 并要求用新的 Idempotency-Key 重试，且不得上传旧 bindings。
- 如果 name 已删除或 tombstoned，不能用旧 value 成功发布；内部 rollback / rematerialize 也必须遵守该版本允许的 revision 和 tombstone 状态。
- secret revision 不能在 delete / recreate 后复用。pages-api 需要用站点、name 维度的历史最大 revision 生成下一 revision，并在 put / delete 与审计写入中用 CAS / 条件写入 fail closed。

第一版历史版本 rematerialize 是 best-effort 能力，不承诺 runtime config 轮换后一定能重建当时版本。若记录的 revision 对应 value / provider ref 已不可用、已删除或已 tombstoned，必须 fail closed。后续如果要支持强可重建，需要另行设计 append-only revision store 或 provider version ref retention，并重新评审 secret 保留期限和删除语义。

## Slot Worker 隔离要求

`normal-worker-slot` 模式会复用一组预创建 Worker script。slot 通过 `worker_slots` 的 `environment`、`status`、`assigned_site_id`、`assigned_version_id` 做分配隔离，但底层 Worker script 名可能在释放后被其它站点复用。因此引入 runtime vars / secrets 后，不能依赖 Cloudflare 保留或清理上一次部署的 bindings。

安全要求：

- 每次 slot Worker 上传都必须发送完整 Worker metadata，包括本次版本唯一允许的全部 bindings。
- 本次未物化的 runtime vars / secrets 绝不能因为 slot 复用而残留在 Worker runtime。
- 如果 Cloudflare multipart PUT 无法保证移除旧 bindings，平台必须在重新分配 slot 前执行显式清理，例如上传不带业务 bindings 的 placeholder Worker，或调用 provider 能力删除旧 bindings。
- slot release / cleanup placeholder 只能保留平台必要 binding，例如 KV gateway service binding；不得保留业务 runtime vars 或 secrets。
- slot 从 `cleanup_pending` 回到 `available` 前必须完成清理。清理失败时保持不可分配状态，不能把可能残留业务 secret 的 slot 分配给其它站点。
- 部署成功后的旧 slot cleanup 如果失败，不能静默把 slot 标成可用；应保留 `cleanup_pending` / `disabled` 等不可分配状态，并提供维护重试路径。
- WFP user worker 模式每个版本使用独立 Worker 名，但仍应按同一原则上传完整 bindings，避免 provider 行为差异造成旧配置残留。

这条要求是 P0 安全边界：任何站点都不能在新部署或 slot 复用后读到其它站点或旧版本未物化的 runtime vars / secrets。

## Pages API 兼容策略

本次改造分为 CLI 体验改造和 runtime 能力改造。不是所有内容都需要 pages-api 配合。

只需要 CLI 处理的内容：

- deploy 解析命令行位置参数、显式 `--config` 和当前目录 `xd-cell.config.json`，并合并成有效 deploy 配置。
- 新 help / llms 文档。
- `xd-cell.config.json` 新模板字段解析，例如 `name`、`main`、`assets.directory`。
- `--assets <dir>` 映射为现有 `worker-with-assets` upload plan。
- 不公开 `--env` 和 rollback 普通用户心智。

需要 pages-api / provider 配合的内容：

- `secrets put/delete` API、权限、站点级密文存储或 provider secret 管理、审计。
- 站点级 secret store：`secrets put` 持久化 value，Worker deploy 注入站点当前启用的 secrets。
- multipart metadata additive 支持 `vars` 对象，缺省为空对象；服务端必须校验字段形态和 binding name。
- site version 存储新增 vars / secret name 物化字段或等价 metadata。
- Worker upload 时注入 plain text env bindings、secret bindings 或 provider 支持的等价机制。
- `packages/wfp-client` / normal worker provider 的 binding normalize 需要 additive 支持 plain text env 和 secret binding 类型，不能只接受现有 service binding。
- normal-worker-slot 模式下保证每次上传全量 bindings，并在 slot 释放/复用前清理业务 runtime vars / secrets。
- 如果 CLI 为 `--assets <dir>` 引入新的 multipart metadata 结构，pages-api 需要 additive 兼容解析。

pages-api 必须兼容老版本 CLI。原因是 skill、agent、本地 CLI、CI 里的 CLI 版本可能短期滞后，服务端不能要求所有客户端同步升级。

兼容原则：

- 继续接受当前 `schemaVersion: 1` multipart upload 结构，包括 `siteSlug`、`requestedFallback`、`publishPlan`、`assetManifest`、`workerMainModuleName` 和 `workerModules`。
- 新字段只能 additive，例如 `vars`。缺省时按 `{}` 处理。
- 只有破坏性协议变化才考虑升级 schema version。第一版应优先保持 `schemaVersion: 1` additive 扩展。
- artifact `contentHash` 继续只表示上传文件和 Worker bundle 内容，不混入 runtime vars 或 secrets。显式请求里的 runtime vars 应进入 deployment request hash；如需要暴露给调试或审计，可单独计算 `runtimeConfigHash`。
- idempotency / request hash 必须包含请求中显式提供的 vars 名称和值的受控摘要；老请求缺字段时按未提供处理，保持旧行为不变。
- request hash 不包含 vars 明文 value、secret value、secret value digest，也不包含当前站点级 secret / vars store 的可变状态。同一个 artifact 修改显式 vars 后重新 deploy，应产生相同 content hash，但 deployment request hash 会变化；仅执行 `secrets put/delete` 或改变站点级当前 vars 后，使用相同 idempotency key 重试同一 deploy 请求应能按原请求 replay。

pages-api 运行时还需要 Worker secret `SITE_SECRET_ENCRYPTION_KEY` 作为站点级 secret store 的加密 key；该 key 不得写入 wrangler vars、GitHub vars、README 示例或测试 fixture 的真实值。production / staging 模板只提示需要设置该 Worker secret，不提供占位值。
- provider upload 在 vars 为空且站点没有启用 secrets 时，必须完全等同当前部署行为。
- 老 CLI 不声明 vars 时，pages-api 不应因为远端存在或缺失 runtime 配置而阻断部署。
- 老 CLI 不声明 vars 时，slot Worker 上传也必须清理或覆盖旧业务 runtime bindings，不能继承上一次部署的业务配置。
- pages-api 不应因为第一版 CLI 不公开 rollback 命令而删除或破坏既有 rollback API；已存在的受控内部集成仍应按原兼容策略处理。

## Error Handling

典型错误应可操作：

- `deploy ./dist` 且有效配置里缺少 site：提示缺少 site，并建议 `xd-cell deploy ./dist <site>`，或在 `xd-cell.config.json` 中配置 `name`。
- 配置文件包含 secret-like 字段名或值字段名：拒绝，并提示 secret 使用 `xd-cell secrets put <site> <name>` 管理。
- `vars` key 疑似敏感：拒绝，并提示改用 secrets。
- assets-only 发布包含 `vars`：允许但提示本次静态发布会忽略 `vars`，不会注入、同步或清空站点级 vars。
- `secrets put` 在非 TTY 且未传 `--stdin`：拒绝，并提示使用 `--stdin`。
- runtime config 权限不足：只提示没有站点发布权限，不暴露目标 name 是否已存在。
- 用户传入 Cloudflare route/domain/account/token 字段：拒绝，并说明底层平台资源由 XD Cell 托管。

## Tests

需要 focused `node:test` 覆盖：

- `deploy <entry> <site>`、`deploy [entry]` 和 `deploy --config <file>` 都能合并成有效 deploy 配置。
- `deploy` 在当前目录存在完整 `xd-cell.config.json` 时可从自动发现配置发布。
- `deploy` 自动发现只读取当前工作目录 `xd-cell.config.json`，不读取父目录配置。
- `deploy` 自动发现不读取旧 `pages.config.json`。
- 显式 `--config <file>` 不与自动发现的 `xd-cell.config.json` 合并。
- 单个位置参数永远按 entry 覆盖处理，不按 site 解释；`deploy demo` 在有效配置缺少 site 时给出可操作错误，若自动发现配置提供 `name`，则 `demo` 作为 entry 覆盖。
- 缺少 site 或入口时给出可操作错误，提示 `xd-cell deploy <entry> <site>` 或配置 `xd-cell.config.json`。
- `--token` 优先于 `XD_CELL_API_TOKEN`，`XD_CELL_API_TOKEN` 优先于本地 secret store。
- 用户在当前 shell 中 `export XD_CELL_API_TOKEN` 后，API 命令无需 login 或显式 `--token` 也能使用该 token。
- `XD_CELL_API_TOKEN` 不写入本地 profile / secret store，不出现在 stdout、stderr、JSON 输出或错误详情中。
- 本地命令不因为存在 `XD_CELL_API_TOKEN` 而报错，也不读取本地 secret store。
- `--token` 和 `XD_CELL_API_TOKEN` 都按 bearer credential 处理，由 pages-api 判定 actor；help / 错误提示优先推荐 `login` 和 `XD_CELL_API_TOKEN`。
- `deploy --config xd-cell.config.json` 从模板读取 `name`、`main`、`assets.directory`、`assets.not_found_handling`、`vars`。
- 配置文件内相对路径以配置文件所在目录解析；当前目录自动发现和显式 `--config subdir/xd-cell.config.json` 都有覆盖。
- 新模板拒绝旧字段：`site`、`source`、`dir`、`worker.entry`、`assets.fallback`、`env`、`secrets`、`environment`。
- 配置文件拒绝 secret-like 字段名和值字段名、非法 vars 对象、重复/非法 binding name。
- 配置文件和 deploy metadata 拒绝平台保留名、保留前缀以及 vars / secret / assets / service binding 重名。
- 配置文件和 deploy metadata 中的 `vars` 声明拒绝疑似敏感 key。
- 静态资源、Worker-only、Worker with assets 三种 upload plan。
- `assets.not_found_handling` 支持 `none`、`single-page-application`、`404-page`，默认 `none`。
- 第一版普通 deploy help 不包含 `--fallback`；传入 `--fallback` 或配置 `assets.fallback` 时应提示改用 `assets.not_found_handling`。
- 第一版不存在 `vars put/delete/list` 普通命令。
- assets-only 发布中出现 `vars` 不会失败，但本次发布忽略 `vars`，不会注入、同步或清空站点级 vars。
- artifact `contentHash` 不随 runtime vars / secrets 变化；deployment request hash 只随请求中显式 vars 变化，不随站点级 secrets / vars 当前状态变化。
- vars 或站点级 secret value 改变后，同 artifact 重新 deploy 的 artifact `contentHash` 不变；显式 vars 改变会改变 deployment request hash，站点级 secrets / omitted vars 改变不会改变同一请求的 request hash。provider upload 使用该版本开始发布时锁定的 runtime config snapshot。
- deploy 在服务端使用同一 runtime config 快照完成权限校验、revision hash、version 记录和 Worker upload；并发 `secrets put/delete` 导致 revision 变化时 fail closed 或整体重试。
- deploy JSON 输出不包含 vars value 和 secret value。
- 第二次 deploy 的有效配置不包含某个 var 时，Worker upload metadata 不包含该 var binding。
- `secrets delete` 后下一次 Worker deploy 不包含该 secret binding。
- provider upload 成功但 version / route / snapshot 写入失败时，包含 runtime bindings 的 Worker / slot 会被清理；清理失败时 slot 不回到 available。
- provider binding normalize 接受 env / secret binding，且仍拒绝未知 binding 类型和非法 name。
- `secrets put` 交互 / stdin 输入，不接受 value 位置参数。
- `secrets delete` 幂等或模糊不存在行为。
- 不存在 `vars list` / `secrets list` 普通命令。
- 第一版普通 CLI help 不包含 rollback 命令。
- API 层不返回、不记录 vars value 或 secret value。
- normal-worker-slot 复用时不残留上一站点或上一版本的 business runtime env / secrets。
- `secrets put/delete` 使用站点发布权限，能发布 `demo` 的凭证只能管理 `demo` secrets，不能影响其它站点。
- 只读 / status 权限不能执行 `secrets put/delete`。
- 发布权限文案提示高信任风险：可上传代码，也可设置并使用该站点 secrets。
- runtime config 审计事件不包含 vars value、secret value、裸 value digest 或 provider secret ref。
- site version 内部 secret `valueHash` 使用带 pepper/HMAC 的不可枚举摘要，不使用裸 sha256，且不进入公开响应或普通审计详情。
- vars / secret name hash 使用带 pepper/HMAC 的不可枚举摘要，不使用裸 hash；受控 name 只在受限内部审计视图展示。
- provider secret ref 不出现在公开响应、CLI JSON 或普通审计详情中。
- site version 保存规范化 vars / secret name 集合和 runtime config revision 信息；`runtimeConfigHash` 不能替代 name 集合。
- 老 CLI multipart 请求在 pages-api 上继续成功。
- 老 CLI 请求缺省 vars 时保持旧部署行为。
- runtime config 能力未完整开启时，非空 vars 或站点级 secrets 注入返回 `RUNTIME_CONFIG_UNSUPPORTED`，不能静默忽略。
- `vars` / `secrets put` 覆盖 value 大小、key 数量、binding 数量、请求体大小和 provider limit 的边界测试。
- public llms / `apps/pages-skill` 不包含 `--env staging`、普通 rollback 指引、provider 资源、内部 API 路径或 Cloudflare 资源细节；internal llms 不随普通 skill 发布。

## Help 文案

对外 help 应保持 XD Cell 语义：

```txt
用法：
  xd-cell deploy <entry> <site> [选项]
  xd-cell deploy [entry] [选项]
  xd-cell deploy --config <file> [选项]

发布业务站点到 XD Cell。
entry 是静态资源目录或 Worker 入口；site 是业务站点名，可由位置参数或 xd-cell.config.json 的 name 提供。
未传 --config 时，CLI 会读取当前目录的 xd-cell.config.json；单个位置参数始终按 entry 解释。
底层路由、执行环境和平台资源由 XD Cell 托管。
```

不要写：

```txt
xd-cell deploy 是 wrangler deploy 的子集
```

## CLI / Skill / llms 真相源

用户、CI 和 agent 的操作入口都应以 CLI 为唯一执行入口。文档维护边界放在 CLI 领域内，避免 `help`、skill、README 和 agent 文档互相复制参数表后漂移。

建议真相源分层：

- CLI command spec：在 `apps/pages-cli` 内维护命令、参数、选项、错误码、JSON 输出 schema 和 hidden/internal 标记的结构化定义。
- CLI help：从 command spec 生成或读取同一份 spec 渲染，面向普通用户，只包含公开命令和公开选项。
- CLI 领域 public llms：从同一份 command spec 生成，随 `@xd-cell/cli` 或 `@xd-cell/skill` 打包，面向普通 agent，可包含更明确的流程约束、JSON schema 和错误处理，但不得暴露 secret、provider、Cloudflare resource id 或公开 help 不允许的普通用户心智。
- CLI 领域 internal llms / maintainer docs：只面向平台维护者和受控 CI，用于说明 staging smoke、hidden/internal flag、回滚维护入口和故障排查。该内容不得随普通 `apps/pages-skill` 发布，也不得被 `/skill.md` / `/readme.md` 当成 agent 默认入口。
- `apps/pages-skill`：只保留能力路由、版本自检、安全规则和“执行前查询内置 CLI help / llms”的流程，不复刻完整命令参数。
- `apps/pages-api/src/public-docs.js` 的 `/skill.md` / `/readme.md`：只提供轻量入口、环境地址和“使用 CLI”的约束，不作为详细命令真相源。

从 CLI command spec 生成 llms 不应增加额外手写文档负担；新增命令或选项时，维护者只更新 CLI command spec 和必要测试，生成的 help / llms 一起变化。若第一版暂不抽象完整 spec，也应至少把 help 文案、help JSON 和 pages-skill 引用收敛在 CLI 包内，避免在 API public docs 里再维护一份 deploy 参数表。

本次改造的同步要求：

- 普通 CLI overview 不展示 `rollback`，`xd-cell rollback` 和 `xd-cell help rollback` 在第一版都返回不支持；内部回滚能力只保留在 pages-api / 维护者流程中，不进入普通 CLI。
- `apps/pages-skill/skill/references/cli.md` 查询命令列表需要移除普通 rollback 指引；新增 `secrets put/delete` 时只按 CLI help / llms 决定是否可用。
- `/skill.md`、`/readme.md` 和 `docs/api-boundary.md` 不应继续把 rollback 写成普通用户常用流程。
- help / llms 必须体现 `vars` 是 deploy 配置字段，`secrets` 是站点级 secret 管理命令；第一版不提供普通 `vars put/delete/list` 或 `secrets list`，secret value 不进配置文件。
- help / llms 可以引导用户、CI 和 agent 使用 `XD_CELL_API_TOKEN` 注入 token，但必须说明不要回显、持久化、提交或截图 token。
- 普通 `apps/pages-skill` 只能引用 public llms；不得引用包含 `--env staging`、rollback 维护命令、provider 资源、内部 API 路径或 Cloudflare 资源细节的 internal llms。

## Rollout

建议分阶段：

1. CLI 命令解析、help、发布模板读取和错误提示。
2. `--assets` 与新模板映射到现有 upload plan。
3. pages-api additive 兼容 `vars` metadata 字段，缺省保持老 CLI 行为；完整 runtime config 能力未开启前，非空 `vars` 或站点级 secrets 注入必须返回 `RUNTIME_CONFIG_UNSUPPORTED`，不能静默忽略。
4. `secrets put/delete` API、CLI、站点级 secret store 和发布权限校验。
5. deploy 校验 vars、读取站点级 secrets 快照，并注入 provider。
6. 引入或收敛 CLI command spec，生成 / 同步 help JSON 和 CLI 领域 llms。
7. 更新 `apps/pages-skill`、`public-docs` 和 `docs/api-boundary.md`，使 agent 继续以 CLI help / CLI 领域 llms 为准，并移除普通 rollback 指引。
