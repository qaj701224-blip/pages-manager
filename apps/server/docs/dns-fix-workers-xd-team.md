# 修复 *.workers.xd.team DNS 解析失败

## 问题

`*.workers.xd.team` 下的子域名（如 `test.workers.xd.team`）DNS 解析失败，Cloudflare 侧 Worker 绑定和证书均正常。

## 原因

`xd.team` 是 Cloudflare partial zone（CNAME 接入）。partial zone 要求 CNAME 目标格式为 `<主机名>.cdn.cloudflare.net`，Cloudflare 只为存在代理记录的主机名返回 IP。

`xd.team` 根域没有走 Cloudflare 代理（根域有其他用途），所以 `xd.team.cdn.cloudflare.net` 不会返回任何 IP：

```bash
dig xd.team.cdn.cloudflare.net A +short        # 空 — 根域未接入 CF
dig workers.xd.team.cdn.cloudflare.net A +short # 104.18.15.107 — 子域已接入 CF
```

之前 `workers` 和 `*.workers` 的 CNAME 都指向了 `xd.team.cdn.cloudflare.net`，解析链在这里断了。

## 修复

CNAME 目标改为 `workers.xd.team.cdn.cloudflare.net`：

| 子域名 | 修改前 | 修改后 |
|---|---|---|
| `workers` | `xd.team.cdn.cloudflare.net.` | `workers.xd.team.cdn.cloudflare.net.` |
| `*.workers` | `xd.team.cdn.cloudflare.net.` | `workers.xd.team.cdn.cloudflare.net.` |

`_acme-challenge.workers` 的 DCV 记录不受影响，无需修改。

## 备选方案

如果修复后仍有问题，可联系 CF 商务将 `workers.xd.team` 作为独立 partial zone 接入，通配符 CNAME 即可按标准方式工作。
