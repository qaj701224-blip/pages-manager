# Cloudflare Partial Zone CNAME 接入指南（xd.team）

## 背景

`xd.team` 在 Cloudflare 使用 **partial zone（部分区域 / CNAME 接入）** 模式，DNS 权威服务器在 DNSPod，不是 Cloudflare NS 托管。

## CNAME 接入的工作原理

partial zone 通过 CNAME 将流量导向 Cloudflare，格式为：

```
<完整主机名>.cdn.cloudflare.net
```

Cloudflare 收到请求后，根据 HTTP `Host` header 查找 zone 内的配置（DNS 记录、Worker 绑定等），路由到对应服务。

**关键约束：Cloudflare 只为 zone 内存在代理记录的主机名生成对应的 `.cdn.cloudflare.net` A 记录。**

## xd.team 的特殊情况

`xd.team` 根域没有接入 Cloudflare 代理（根域有其他用途），因此：

```bash
dig xd.team.cdn.cloudflare.net A +short          # 空 — 根域未接入 CF，无 IP
dig workers.xd.team.cdn.cloudflare.net A +short   # 104.18.15.107 — 子域已接入，有 IP
```

对比 `xd-ads.com`（根域已接入 CF 代理）：

```bash
dig xd-ads.com.cdn.cloudflare.net A +short        # 104.21.59.113 — 根域已接入，有 IP
```

这就是 `xd-ads.com` 可以用 `*` 泛域名 CNAME → `xd-ads.com.cdn.cloudflare.net` 而 `xd.team` 不行的原因。

## DNSPod 配置规则

在 `xd.team` zone 下新增 Cloudflare 代理域名时，CNAME 目标**必须指向已接入 CF 的主机名**，不能用根域后缀：

```
# ✅ 正确
workers        CNAME  workers.xd.team.cdn.cloudflare.net.
*.workers      CNAME  workers.xd.team.cdn.cloudflare.net.

# ❌ 错误 — 根域未接入 CF，此地址无 IP
workers        CNAME  xd.team.cdn.cloudflare.net.
*.workers      CNAME  xd.team.cdn.cloudflare.net.
```

## 泛域名通配符的使用

泛域名 CNAME（如 `*.workers`）可以正常工作：

1. DNSPod 通过通配符将 `*.workers.xd.team` 解析到 Cloudflare IP
2. Cloudflare 边缘通过 `Host` header 识别实际访问的主机名
3. 但 Cloudflare 侧仍需为每个子域名单独添加 Worker custom domain 绑定

```
解析链路：
test.workers.xd.team
  → DNSPod *.workers 通配符
  → CNAME workers.xd.team.cdn.cloudflare.net
  → A 104.18.14.107 (Cloudflare Anycast)
  → Host: test.workers.xd.team
  → Cloudflare 查找 Worker 绑定
  → 路由到 pages-domain-test Worker
```

## 证书（DCV 委派）

`*.workers.xd.team` 的通配符证书通过 DCV 委派实现，DNSPod 记录：

```
_acme-challenge.workers  CNAME  workers.xd.team.<token>.dcv.cloudflare.com.
```

此记录指向 `dcv.cloudflare.com`（证书验证专用域），与 `cdn.cloudflare.net` 无关，不受上述问题影响。

## 备忘

- 如果未来需要让 `xd.team` 也支持根域后缀式泛域名 CNAME，需要在 DNSPod 给根域加一条指向 CF 的记录，但根域目前有其他用途，不可行
- 备选方案：联系 CF 商务将 `workers.xd.team` 作为独立 partial zone 接入，通配符 CNAME 即可按标准方式工作
