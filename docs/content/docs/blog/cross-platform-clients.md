---
title: 《跨平台智能体客户端的实现：Web、桌面端与移动端》
description: 同一份 React 界面跑在浏览器和 Tauri 外壳里：20 个 OKLCH 令牌、一条只剥一次 /api 的链路，以及原生外壳里还没接通的那部分。
---

# 《跨平台智能体客户端的实现：Web、桌面端与移动端》

客户端仓库 `frontend/` 里只有一份界面源码。它同时是浏览器应用、Tauri 桌面应用和 Tauri Android 应用。三个形态的差异集中在 `src-tauri/tauri.conf.json` 和一个 6 行的 Rust 入口里，其余全部共用。

「共用」这个词得拆开看：共用的是组件、状态和 CSS 令牌；不共用的是外壳配置、会话传输和平台 SDK。最后一项决定了这个客户端现在能跑多远，第 6 节写。

---

## 1. 入口：`main.tsx` 里的四个去处

`frontend/src/main.tsx` 一共 21 行，按路径决定挂载哪个组件：

```tsx
const App = import.meta.env.MODE === 'audit' ? lazy(() => import('./audit'))
  : location.pathname === '/preview/appearance' ? lazy(() => import('./product'))
  : location.pathname.startsWith('/workspace') ? lazy(() => import('./workspace')) : Auth;
```

四个去处是本地审计台、外观预览页、知识工作区和认证页。除认证页直接 import，其余三个都是 `lazy()`。审计台只读开发者本机的 `private/audit/`；`vite.config.ts` 的 `fs.deny` 在开发服务器上同时挡掉 `.env*`、`*.crt`/`*.pem`/`*.key`、`private/`、`research/` 和 zip，所以审计模式不会把私有素材混进普通构建。

Tauri 侧没有第二套入口。外壳开发时加载 `http://127.0.0.1:5173`，打包后加载 `../dist`，窗口 1100×760、最小 360×600。Rust 侧只有这些：

```rust
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run TJUClaw");
}
```

`Cargo.toml` 的依赖是 `tauri = { version = "2", features = [] }`，没有插件。权限清单 `src-tauri/capabilities/default.json` 只给了一项 `core:app:allow-version`，文件里的注释是「Only read the app version; no filesystem, shell or network plugins」。外壳能这么薄，是因为界面要的东西全在 HTTP 请求和系统 WebView 里，不需要 Rust 侧提供文件系统或 shell 能力。

打包目标写死在配置里：`deb` 和 `nsis`，Android `minSdkVersion` 是 24。Linux 构建依赖 GTK 3 与 WebKitGTK 4.1，Windows 依赖 MSVC，Android 依赖 Java 17、SDK 36、NDK 27.2.12479018（`README.md`）。CI 产出未签名 NSIS、arm64 debug 签名 APK 和 deb；仓库里没有真机安装与原生登录的验收记录。

---

## 2. 外观：20 个令牌，一次属性写入

`src/product.css` 的 `:root` 里有 20 个变量，颜色值全部写成 OKLCH；`:root[data-theme=dark]` 覆盖其中 16 个，强调色走 `:root[data-accent=blue] { --primary: var(--blue) }`，`--blue` 在两个主题下分别是 `oklch(50% .23 260)` 和 `oklch(67% .18 255)`。圆角与层级（`--radius-control: 16px`、`--radius-panel: 40px`、`--z-overlay: 40`、`--z-dialog: 50`）不随主题变。

对比度可以算：把 token 从 OKLCH 换到 sRGB，再按 WCAG 相对亮度求比值，浅色主题 `--foreground` 对 `--background` 约 18.3:1，暗色约 18.1:1；次要文字 `--muted-foreground` 浅色 `oklch(49% 0 0)` 约 6.0:1，暗色 `oklch(70% 0 0)` 约 7.2:1。也就是正文那一层远超 AAA 的 7:1，而浅色主题的次要文字停在 AA 以上、AAA 以下。

状态在 `src/lib/appearance.ts`（64 行）：

- 用 `useSyncExternalStore` 暴露 `useAppearance()`，写入口只有 `setAppearance()`；存储 key 是 `tjuclaw.appearance.v1`，默认 `system` + `mono`。
- `apply()` 在模块加载时执行一次，写 `documentElement.dataset.theme/accent`、CSS `color-scheme` 和 `<meta name="theme-color">`（暗色 `#101010`、浅色 `#fafafa`）。`main.tsx` 里 `import './lib/appearance'` 排在 `import './product.css'` 之前，所以根元素上的属性在首次渲染前就位——不需要内联脚本，也就不需要为它放宽 Tauri 的 CSP（`script-src 'self' 'wasm-unsafe-eval'`，唯一的例外是 WASM）。
- `system` 模式监听 `matchMedia('(prefers-color-scheme: dark)')`；另外监听 `StorageEvent`，同源的其他标签页改主题会跟过来。
- 读出来的值先校验，非法值回落默认。`localStorage` 抛异常时 `canPersist = false`，界面显示「这次会话里外观已生效，浏览器限制了存储，关掉后可能要重设」，而不是假装存下了。

Tailwind 侧用 `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))` 认同一个属性，`@source` 只列了 `product.tsx`、`auth.tsx`、`workspace.tsx` 和 `components/ui/`。`dark:` 变体和手写 CSS 查的是同一个开关，仓库里没有第二套主题状态，也没有 `next-themes`（`UI.md` 明确禁止）。

---

## 3. 同源 `/api`：一条出口，剥点在回源处

浏览器和 Tauri 外壳里的业务代码只发相对路径。`src/lib/auth.ts` 的 `authRequest` 是唯一入口，第一行就拒绝不属于 `/api/` 的路径：

```ts
if (!path.startsWith('/api/')) throw new Error('Invalid API path');
const response = await fetch(path, { ...init, headers, signal: controller.signal,
  credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
```

配套的东西：15 秒 `AbortController` 超时、`Accept: application/json`、仅在 body 是字符串时加 `Content-Type`；204 当空对象；解析失败按 503 抛 `AuthError`；`readSession` 把 401/403 映射成 `null`，会话形状不对（`email_verified` 不是 `true`、`expires_at` 已过期）则直接抛错，不把半截身份当登录成功。凭据在 HttpOnly Cookie 里，JS 读不到。文件下载用的是裸 `fetch`，但同一组 `credentials: 'same-origin'`、`cache: 'no-store'`、`redirect: 'error'`。

域名不在客户端代码里，所以在中间接。生产链路上没有 Nginx：

```text
浏览器 / Tauri WebView
   │  fetch('/api/auth/session')   相对路径，没有域名
   ▼
   开发：Vite dev / preview 代理
   │     '/api' → API_PROXY_TARGET 或 http://127.0.0.1:8080
   │     rewrite: path => path.replace(/^\/api/, '')
   ▼
   生产：app.tjuclaw.cloud
   │     EdgeOne 静态资产 + Edge Function functions/api/[[path]].js
   │     只换 origin（硬编码 https://auth.tjuclaw.cloud），路径原样带走
   ▼
   auth.tjuclaw.cloud（同一张 EdgeOne 边缘网，按 Host 回源）
   ▼
   <源站>:8443  HAProxy，独立 systemd 单元 tjuclaw-newapi-origin
   │     精确 Host 匹配；非 /api 一律 404；regsub(^/api,) 剥一次
   ▼
   127.0.0.1:18080  Go API（路由表里没有 /api 这个前缀）
```

几个默认值：Go API 的 `HTTP_ADDR` 缺省 `127.0.0.1:8080`（`backend/cmd/api/main.go`），HAProxy 的 `auth_backend` 指向 `127.0.0.1:18080`（`ops/ansible/roles/newapi_origin/defaults/main.yml`），Vite 代理默认转给前者、可以用 `API_PROXY_TARGET` 换。生产回源另有一个 `newapi_origin_auth_enabled` 开关，Ansible 默认 `false`，要靠 inventory 打开。线上是打开的——这一点可以直接验：`auth.tjuclaw.cloud` 的根路径返回 `302` 跳产品登录页，非 `/api` 路径返回 `404`，而这两条规则都只在开关打开时才存在。

Edge Function 那 39 行里，路径改写只是顺带产物，主要在处理代理层的活：剥掉逐跳头并删除客户端自带的 `x-forwarded-for` 和 `forwarded`（伪造来源 IP 最省事的手段），`redirect: 'manual'` 不让边缘替浏览器跟随跳转，用 `new Response(upstream.body, upstream)` 克隆响应以免 `Set-Cookie` 被拍平成一个字段，出口强制 `no-store`，失败返回 `502 {"error":{"id":"upstream_unavailable"}}`。这个文件属于客户端仓库，随 Web 制品一起打包（`cp -R functions edge-deploy/functions`，再由 `edgeone makers build` 编成 `.edgeone/edge-functions/index.js`），所以应用自己的 API 路由和应用的版本是同一次发布。

真正要记住的只有一条不变量：**`/api` 前缀在整条链路上只被剥离一次，剥离点在回源处。**

| 环节 | 对 `/api` 前缀做什么 |
| --- | --- |
| 客户端 | 只写相对路径，不拼域名 |
| Vite dev / preview 代理 | 剥（`replace(/^\/api/, '')`） |
| Edge Function | 不剥：`target.pathname = incoming.pathname` |
| HAProxy | 剥：`regsub(^/api,)` |
| Go API | 没有 `/api` 路由 |

剥两次，`/api/auth/session` 会变成 `auth/session` 落到别的处理器上；剥零次，Go 的 mux 会全部拒掉，而边缘和浏览器两侧看上去都是成功的。开发和生产走的是同一条规则。

---

## 4. 工作区：一棵条目树，不是三栏

`/workspace` 的骨架是两列。`workspace.css` 里 `.workspace-shell` 是 `grid-template-columns: 256px minmax(0, 1fr)`，`data-sidebar=closed` 时第一列压成 0。侧栏和主区之间没有第三个面板。

侧栏从上到下：知识库切换（`<select>`）、检索笔记输入框、条目树（`role="tree"`，按 `parent_id` 嵌套，有子项的节点带折叠按钮）、新建笔记/智能体/工作环境/上传文件，底部是设置与退出。主区顶栏是折叠侧栏按钮、当前库名、保存状态，以及发布、市场、删除。

主区的内容由条目类型决定，和 `CONTEXT.md` 里「同一棵条目树、打开方式由类型决定」是同一件事：

| 条目类型 | 打开后是什么 |
| --- | --- |
| 笔记 / 工作环境 | 标题输入框 + Markdown `<textarea>`，正文经 `patchEntry` 落库 |
| 智能体 | 会话记录 + 输入框；打开的是会话，不是编辑器 |
| 文件 | 类型、字节数与下载按钮，图片先临时预览 |

笔记保存是 500ms 防抖：输入后显示「正在写入…」，`patchEntry` 成功才变「已写入」。接入别人发布的只读快照时，新建和删除按钮直接不渲染，智能体条目显示「这是接入快照里的智能体，只能查看，不能在这里对话」；写入分支在代码里就被挡掉了。

响应式只有一个断点：`@media (max-width: 860px)` 下网格变单列，侧栏改成固定定位的浮层，关闭时 `display: none`。移动端没有底部导航，也没有第二条常驻状态栏。另外 `sidebarOpen` 的初值是 `true`，所以在窄屏上首屏就是侧栏盖住主区。

---

## 5. 认证页与验证码输入

登录页、密码页和验证码页都在 `src/auth.tsx`。验证码输入是这个仓库里少数值得单独讲的自制控件：`src/components/ui/otp-input.tsx`（238 行）只放一个真实的原生 `<input>`，属性是 `inputMode="numeric"`、`autoComplete="one-time-code"`、`maxLength=6`，那 6 个格子是 `aria-hidden="true"` 的展示层。

收益是可测的：系统短信/邮件自动填充、物理键盘、光标选择都作用在真实输入框上，不存在「6 个 input 互相抢焦点」那类问题。代价是要自己处理指针——`onPointerDown` 用点击坐标除以格宽算出目标格，落在已有数字上就选中该位准备替换；粘贴和全角数字在 `normalizeOtpDigits` 里归一（U+FF10–U+FF19 换成 0–9）。发码前先过 Cap 验证，token 作为 `captcha_token` 提交。

外观、键盘访问和响应式截图的回归在 `frontend/scripts/ui.spec.mjs`：六个视口（360×800、390×844、768×1024、1440×900、1920×1080、2560×1440）各出浅色与深色两张，共十二张，产物落在忽略目录 `test-results/ui/`。

---

## 6. 还没接通的

1. **原生外壳里的会话传输没有落地。** 打包后的 CSP 里 `connect-src` 只有 `'self'`、`asset:`、`ipc:` 这类来源，不含任何 https 源；权限清单也只给了读版本号。桌面和 Android 外壳现在能渲染界面，但还没有一条经过评审的路径把同源 Cookie 会话带进去。`CONTEXT.md` 对它的要求很明确：原生客户端需要单独评审的会话传输，不放宽 CORS，不把 Cookie 当 bearer 用。
2. **安装包没有签名背书。** Windows 是未签名 NSIS，Android 是 debug 签名 APK，`README.md` 自己写着构建通过不等于真机验收；仓库里也确实没有真机安装或原生登录的记录。
3. **浏览器回归跑的是 mock。** `workspace:test` 用 `page.route('**/api/**')` 拦下所有请求，证明的是界面行为，不是持久化或归属；真实 Kratos 会话与归属回归在私有集成仓库的 `auth:test` 里，需要 Docker 和 Chromium。
4. **执行面没接。** 智能体条目打开的是落库的会话，配好上游后可以对话；沙箱、Pi/omp 执行、WeKnora 检索、SSH 工作环境都还没有（`CONTEXT.md` 的 `_Status_` 记录）。
5. **两处文档漂移。** `frontend/AGENTS.md` 写包版本 `0.0.25`，`package.json` 是 `0.0.27`；根 `AGENTS.md` 里还留着「Vite or EdgeOne/Nginx strips /api once」，但生产链路里没有 Nginx，`ops/ansible/README.md` 也写明核心主机不部署 Nginx 或应用网关——真正做这件事的是边缘函数和 HAProxy。

---

## 7. 最后

这套客户端只有两条规则值得记住：界面只有一份，出口只有一个。

一份界面意味着主题、组件、键盘行为和响应式断点只需要改一处；也意味着一个在浏览器里成立的前提（同源 Cookie）会成为所有平台的共同前提，所以上面第 1 条不是打包问题，是模型问题。

一个出口意味着审查网络行为时只需要看 `authRequest` 那几行和回源那一跳。`/api` 剥几次这种问题会在开发代理和生产回源两处同时出症状，原因也在这里。

至于桌面和 Android 外壳，现在能证明的只有两件事：同源 `/api` 这条链路在浏览器里成立，以及三个平台的安装包能构建出来。`UI.md` 里那句「Native Windows/Android/Linux behavior still requires testing on those clients」还没有被任何一次真机验证划掉。
