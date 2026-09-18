---
title: 《祖传前后端架构，但是 2026》
description: 一次浏览器请求要穿过几个域名？TJUClaw 服务端的真实拓扑——Go 标准库、两级边缘接力、只剥一次的前缀，与一张不认客户端的会话门禁。
---

# 《祖传前后端架构，但是 2026》

写这篇之前，我在排查一个自己都觉得奇怪的问题：**我们产品的 API 域名到底是哪个？**

浏览器里永远只有 `fetch('/api/auth/session')`，一个相对路径，看不出域名。前端代码里搜不到第二个域名的影子。但后端确实挂在 `auth.tjuclaw.cloud` 上，用户访问的却是 `app.tjuclaw.cloud`。

两者之间的联系藏在客户端仓库的一个文件里：

```js
// frontend/functions/api/[[path]].js
const upstreamOrigin = 'https://auth.tjuclaw.cloud';
```

一行硬编码的字符串。整套「Web 端 API 域名」就是靠它接上的。

所以这篇不打算论证「经典架构为什么好」。先把一次请求的完整旅程摊开，再说其余。

---

## 1. 一次请求的旅程

```text
浏览器  fetch('/api/auth/session')
   │
   ▼  app.tjuclaw.cloud
      EdgeOne 边缘节点
      Edge Function: functions/api/[[path]].js
      —— 把目标 origin 改写成 auth.tjuclaw.cloud，路径原样带走
   │
   ▼  auth.tjuclaw.cloud
      还是 EdgeOne 边缘，按 Host 回源
   │
   ▼  <源站 IP>:8443
      HAProxy（独立 systemd 单元）
      —— ACL 精确匹配 Host；regsub(^/api,) 剥离前缀一次
   │
   ▼  127.0.0.1:18080
      Go API —— 路由里根本没有 /api 这个前缀
```

五个域名（`tjuclaw.cloud`、`app.`、`auth.`、`newapi.`、`excalidraw.`）解析到完全相同的一组边缘 IP。所以这不是「好几个服务」，而是一张边缘网按 Host 分流。把文档站、产品站、API、模型网关、画板拆成五个名字，但共享同一层入口。

`auth.tjuclaw.cloud` 尤其不像一个网站。实测：

| 请求 | 响应 |
| --- | --- |
| `GET /` | `302 → https://app.tjuclaw.cloud/auth/login` |
| `GET /nope` | `404` |
| `GET /api/auth/session` | `401`（未登录） |
| `GET /api/healthz` | `200` `{"status":"ok"}` |

除了 `/api/*`，它什么都不服务。这看着像配置漏了，其实是刻意收窄：一个公开域名如果只能承载 API 路径，就没有机会意外暴露静态目录、上游框架的默认错误页，或者某条忘了加鉴权的调试路由。

HAProxy 里对应的三行很直白：

```text
http-request redirect location https://app.tjuclaw.cloud/auth/login code 302 if is_auth_host is_root
http-request deny deny_status 404 if is_auth_host !is_api_exact !is_api_prefix
http-request set-path %[path,regsub(^/api,)] if is_auth_host is_api_prefix
```

根路径踢回产品站，非 `/api` 一律 404，`/api/x` 改写成 `/x`。

还有一个容易被忽略的细节：HAProxy 使用的是**精确 Host 匹配**（`hdr(host) -i auth.tjuclaw.cloud auth.tjuclaw.cloud:443 ...`）而不是后缀匹配。仓库里有一条回归测试专门构造 `auth.tjuclaw.cloud.evil` 的证书，断言部署前置检查会拒绝它。域名后缀碰撞这类问题，一旦用 `-m end` 之类的宽松匹配就悄无声息地开了。

---

## 2. 唯一的不变量：`/api` 只剥一次

整套拓扑里真正需要记住的规则只有一条：**`/api` 前缀在整条链路上只被剥离一次，剥离点在回源处。**

三个实现都对得上：

| 环节 | 行为 |
| --- | --- |
| Vite 开发代理 | `rewrite: path => path.replace(/^\/api/, '')` → 转发 `127.0.0.1:8080` |
| Edge Function | **不剥**，`target.pathname = incoming.pathname` 原样带过 |
| HAProxy | 剥一次，`regsub(^/api,)` |
| Go 路由 | 注册的路径不带 `/api` |

所以本地开发和生产走的是同一条规则：客户端只认相对路径 `/api/*`，中间任意一跳都可能改变它，但只有回源那一跳真的动手。

这条不变量一旦被破坏，症状很难查。剥两次，`/api/auth/session` 会变成 `auth/session` 落到错误的处理器上，返回一个和真实原因无关的 404；剥零次，Go 的 mux 会拒绝所有请求，而浏览器和边缘层都显示 200 通链——因为边缘确实成功了，失败发生在源站。

---

## 3. 边缘函数真正在做的事

路径改写只是 `functions/api/[[path]].js` 的顺带产物。它主要在处理代理层的脏活：

```js
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
                    'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];
```

1. **剥掉逐跳头**，并额外删掉 `connection` 里列出的自定义头。逐跳头不该被代理透传，`host` 尤其不能——否则源站看到的 Host 会是 `app.tjuclaw.cloud`，而 HAProxy 的 ACL 只认 `auth.tjuclaw.cloud`，请求会被 404。
2. **删掉客户端自带的 `x-forwarded-for` 和 `forwarded`**。这两个头是伪造来源 IP 最省事的手段；删掉之后，HAProxy 那侧的 `set-header X-Forwarded-For %[src]` 才可能是真实值。
3. **`redirect: 'manual'`**。不让边缘自动跟随上游的 3xx，否则登录跳转会在代理内部被吃掉，浏览器永远看不到该跳的那一步。
4. **不重建 Response，而是克隆**：

```js
const response = new Response(upstream.body, upstream);
```

写成 `new Response(body, { status, headers })` 再手工搬头，会把 `Set-Cookie` 拍平成一个字段。会话 Cookie 一旦被合并，多 Cookie 场景下的登录态就会时好时坏——这类 bug 只在特定浏览器路径上出现，极难复现。

5. **出口强制 `Cache-Control: no-store`**，失败时返回 `502 {"error":{"id":"upstream_unavailable"}}`，同样是结构化错误封套，不吐堆栈。

这个文件属于客户端仓库（`frontend/functions/`），部署时随 Web 制品一起打包（`cp -R functions edge-deploy/functions`，再由 `edgeone makers build` 编译成 `.edgeone/edge-functions/index.js`）。也就是说：**应用自己的 API 路由，和应用的版本一起发布。** 换区域、换上游域名，是改代码发版，不是在控制台点几下。刚才把三个站点迁到含大陆的 EdgeOne 项目时，这一点体现得很直接——`upstreamOrigin` 是硬编码的，控制台里改不了。

---

## 4. 后端：标准库、会话门禁、存储插拔

边缘之下是被两层代理包裹的 Go 服务。它监听 `127.0.0.1:18080`，不做 TLS——TLS 终止在 HAProxy，源站用一张自签双 SAN 证书（同时覆盖 `newapi.tjuclaw.cloud` 与 `auth.tjuclaw.cloud`）。同一个 HAProxy 进程也顺带把 `newapi.tjuclaw.cloud` 路由到本机 `:3000` 的模型网关，两个域名共用一套入口和一张证书。

### 4.1 路由：不加框架

```go
// cmd/api/main.go
func handlerWithStore(store task.TaskStore, runStore run.Store, libStore library.Store, gateway ...*auth.Gateway) http.Handler {
    mux := http.NewServeMux()
    ...
    mux.HandleFunc("GET /healthz", ...)
    return mux
}
```

Go 1.22 之后 `ServeMux` 原生支持方法匹配（`"GET /healthz"`）与路径参数（`"GET /entries/{id}"`），第三方路由框架原本最实在的那点理由没了。

真正让标准库在这里站得住的是**依赖缺失时的降级行为**。`handlerWithStore` 在存储未注入时，不是 panic，也不是返回假数据，而是把那组路径注册成明确的 503：

```go
for _, path := range []string{"/libraries", "/libraries/", "/entries", "/entries/",
                              "/sessions", "/sessions/", "/account/model"} {
    mux.HandleFunc(path, func(w http.ResponseWriter, _ *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.Header().Set("Cache-Control", "no-store")
        w.WriteHeader(http.StatusServiceUnavailable)
        _, _ = w.Write([]byte(`{"error":{"id":"auth_not_configured"}}`))
    })
}
```

身份配置缺失返回 `auth_not_configured`，存储缺失返回 `library_storage_unavailable`。**永远不会有一条路径悄悄回落到「假装登录成功」。**

### 4.2 会话门禁

`auth.Gateway.RequireSession` 是所有受保护处理器的入口，顺序固定：

```text
Cookie: session_token=... (浏览器自动附带)
Origin: https://app.tjuclaw.cloud
   │
   ├─ 同源校验：拒绝不受信的 Origin（CSRF 的第一道闸）
   ├─ 会话核验：拿 Cookie 去 Kratos /sessions/whoami 问一次真假
   ├─ 归属锁定：只用返回的 session.Identity.ID 当 OwnerID
   └─ 响应头：Cache-Control: no-store、X-Content-Type-Options: nosniff
```

第三条是整套系统里最不能妥协的一条。**请求体和路径里的任何用户 ID 都不具备权威性**，归属只认身份提供方核验过的 `Identity.ID`。越权访问他人资源时返回的是与「资源不存在」完全相同的 404，攻击者无法靠状态码差异枚举 ID。

浏览器侧还有一个刻意的收窄：Kratos 自助服务流的代理路径被正则限定在 `^/self-service/(login|registration|verification)(/browser|/flows)?$`，Query 参数只放行 `flow`、`id`、`refresh`、`token`，POST body 只放行 `method`、`csrf_token`、`identifier`、`email`、`traits`、`code`、`resend`，并且强制 `method=code`。

这些白名单不是防模型的，是防**重定向注入**的：只要放行调用方自带的 `return_to`，登录流程就能被改造成一个开放的跳转器。

> 身份提供方这里有过一次反复：项目一度切到 ZITADEL，后来又切回 Kratos 邮箱验证码。当前权威是 Kratos，ZITADEL 适配器保留在 `internal/auth/zitadel.go` 供配对回退。两套代码都在，但**只有一个能是活动提供方**（`AUTH_PROVIDER`），不存在并行双身份。

### 4.3 存储插拔

```go
type Store interface {
    CreateRun(ctx context.Context, ownerID, taskID string) (*Run, error)
    GetRun(ctx context.Context, ownerID, runID string) (*Run, error)
    ListRuns(ctx context.Context, ownerID, taskID string) ([]*Run, error)
    ...
}
```

同一套接口有两个实现：`FileStore` 按 `TASK_DATA_DIR` 分目录落盘，`PGStore` 走 `pgx` 连 PostgreSQL。切换只取决于启动时 `DATABASE_URL` 是否为空。

值得说清楚它**不是**什么：文件存储是单进程设计，供本地开发与测试使用，不跨重启丢失记录，但**不能给多个 API 副本共享**，也不是未来的工作区文件服务。把它当成可水平扩展的存储是误读。

---

## 5. 有界防御

后端稳定性很大一部分取决于它多干脆地拒绝不合理请求。

- 请求体上限：任务写入走 `io.LimitReader(r.Body, 16<<10)`，Kratos 流代理走 `http.MaxBytesReader(w, r.Body, 16<<10)`。超限就报 `request_too_large`，不缓冲。
- 服务器超时：`ReadHeaderTimeout: 5s`（挡 Slowloris）、`ReadTimeout: 15s`、`WriteTimeout: 90s`、`IdleTimeout: 60s`。
- 优雅关闭：`signal.NotifyContext` 监听 `SIGINT`/`SIGTERM`，`server.Shutdown(ctx)` 留出排空窗口。

这些数字本身不特别，特别的是它们出现在同一个进程里，而那个进程只有 2 核 2 GB，还要和 PostgreSQL、身份服务、模型网关挤在一起。在有界的环境里，**没有上限的善良代码就是故障源**。

---

## 6. 还没解决的

写到这里该说不足，否则上面那些就只是自我表扬。

1. **未匹配路由的 404 不合契约。** 应用错误统一是 `{"error":{"id":"..."}}`，但 Go mux 的默认 404 是纯文本 `404 page not found`。实测 `GET /api/definitely-not-a-route` 拿到的是后者。客户端解析 JSON 时会失败，得靠状态码兜底。这是一个已知的不一致，不是设计选择。
2. **每个 API 请求至少多一跳。** 浏览器 → 边缘 → Edge Function → 公网回到 `auth.tjuclaw.cloud` → 边缘 → 回源。中间那次 `fetch` 打的是公网域名，所以要在边缘层再走一遍，不是进程内调用。延迟换来的是一致入口与统一审计。
3. **源站是自签证书。** EdgeOne 当前接受它，但这不等于源站具备公信 CA 身份，到期需要单独轮换，不能指望自动续期顺带覆盖。
4. **上游域名硬编码在边缘函数里。** 换区域要改代码重发 Web 制品。对现在的节奏够用，但它是一次发布耦合，不是配置。

---

## 7. 最后

这套东西里我真正满意的不是「用了标准库」或者「单体」，而是**每条规则只有一个执行点**：

- 前缀只剥一次，剥在回源处；
- 归属只认一个 ID，来自身份提供方；
- 存储只有一个接口，切换只看一个环境变量；
- 错误只有一个封套（除了上面那条 404）。

规则只有一个执行点的直接好处是：审查的时候只需要看那一处。架构图可以画得很复杂，但如果每条不变量都能指到一个具体文件的具体几行，它就还是可控的。

至于开头那个问题——API 域名是 `auth.tjuclaw.cloud`，产品域名是 `app.tjuclaw.cloud`，连接它们的是客户端仓库里的一行字符串。
