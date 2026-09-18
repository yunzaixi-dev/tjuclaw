---
title: 《为什么我们把 Agent 的能力做成 CLI：tjucli 的设计》
description: 一个只做公开课程目录的 Go CLI：确定性 JSON 封套、一次调用一个进程、令牌代理下的原子落盘，以及这条路目前还没走完的部分。
---

# 《为什么我们把 Agent 的能力做成 CLI：tjucli 的设计》

标题里的问题有一条很短的答案链。Agent 跑在沙箱里，沙箱里没有校园账号，也不该有。能做什么、不能做什么，必须由沙箱外面的一段代码决定，而这段代码要能被沙箱里的 Agent 直接调用。

`tjucli` 就是那段代码在沙箱内侧的形态：一个可执行文件。整条链路目前只接通了一小段，公开课程共享平台。先说已实现的东西是怎么长的，没实现的部分在第 7 节单独列。

---

## 1. 现在的实际范围

`cli/cmd/tjucli/main.go` 里有一段内置帮助，写的是它自己：

```text
Implemented scope: public course-sharing catalog and file downloads.
No campus login or student credentials are used.
```

`capabilities --json` 返回同一件事：

```json
{"ok":true,"data":{"provider":"public-course-sharing","commands":["course ls","course search","course download"]},"meta":{}}
```

只有三个命令，都在 `course` 下面。`cli/TJUCLI.md` 有一节 Coverage gaps，列出没实现的部分：校园身份与学生登录、课表成绩考试与学业记录、校园卡支付图书馆账号与设施门禁、通知消息组织服务、其他课程平台与私有课程资源。

`CONTEXT.md` 里用户提出的要求比这大：覆盖竞争对手校园功能、微北洋关键功能，以及课程共享平台的资料查询与下载；验收 Demo 要求“至少实现课表、校园信息、课程资料三个可由 Agent 自动调用的校园能力”。

课表那一项一行代码都没有。这是这篇里最该放在前面的事实。现在能自动调用的校园能力只有一个：查公开课程资料并下载。

---

## 2. 封套：让调用方少猜

`cli/internal/tjucli/types.go` 里两个信封结构，成功一个失败一个。`--json` 出现在参数任意位置都行（`extractJSON` 把它从任意位置摘出来，只允许出现一次），输出长这样：

成功：

```json
{"ok":true,"data":{"items":[...]},"meta":{"scope":"course-catalog","pages_scanned":3,"incomplete":false}}
```

失败：

```json
{"ok":false,"error":{"code":"invalid_argument","message":"provider path must not contain traversal segments"}}
```

`meta.scope` 的实际值是 `course-catalog`，不是类目名。`pages_scanned` 与 `incomplete` 是搜索专有字段，来自 `SearchMeta`。

退出码只有两种含义，写在 `NewFlagError` 和 `NewRuntimeError` 里：参数错误是 2，运行期错误是 1。错误码是稳定字符串，`invalid_argument`、`target_exists`、`size_limit_exceeded`、`protocol_error`、`unsafe_redirect` 都能在 `types.go` 与 `provider.go` 里逐个对上。非 JSON 模式下错误走 stderr（`tjucli: <message>`）；JSON 模式下错误走 stdout 的失败信封，退出码同时生效。

标准流的划分比“日志进 stderr”具体一点。业务数据只写在 stdout。人类可读的过程信息在整个仓库里只有一处：`course search` 不加 `--json` 时往 stderr 打一行 `scanned 3 page(s); incomplete=false`。加了 `--json` 之后 stdout 只有一个 JSON 对象，因为源码里确实没有第二个写入点。所以“模型不用切换行”不是设计宣言，是 `r.success` 里那个 `json.Encoder` 的事实。

---

## 3. 为什么是子进程，而不是常驻协议

先把话说清楚：这个仓库里没有 MCP 服务器，也没有 Python SDK。所以我们没有关于它们的任何实测数字，也就不给对比评分。真实发生过的是选型约束，不是跑分。

约束有两条，都能在仓库里指到：

1. 沙箱内的东西不持久。`CONTEXT.md` 定的是 Makers 实例按会话临时存在、不是文件权威，任务在沙箱本地目录执行、提交产物后清理。
2. 凭据不进沙箱。`CONTEXT.md` 的一项分工写了：前端、API、CLI、Pi runtime 与执行隔离分别承担交互、身份与任务归属、校园能力、编排和用户文件边界；校园个人凭据不进前端存储、模型提示或共享宿主全局配置。

对着这两条看四种形态，能核到的只有机制：

| 形态 | 一次调用的机制 | 本仓库状态 |
| --- | --- | --- |
| Python SDK | 模型进程内 import 库并调方法 | 未实现 |
| MCP | 一个常驻进程按 JSON-RPC 应答 | 未实现 |
| HTTP API 直连 | 每次调用打回中心 API，凭据随请求走 | 部分：`tjucli-server` 是这个角色，但调用方是 CLI，不是模型 |
| 子进程 CLI | `fork/exec` 一次，stdout 收 JSON，退出码收结果 | 已实现，`go test -race ./...` 覆盖 |

选第四条的理由是它和上面两条约束对齐：沙箱里不需要常驻进程，一次调用一个进程一个退出码，凭据只以文件路径的形式出现在沙箱里。

这不是“CLI 客观上更好”的论断。如果沙箱允许常驻进程，并且我们愿意自己维护一个协议实现，MCP 也能达到同样目的。没有实测，就不做这种比较。

---

## 4. 双模：standalone 与 remote

`main.go` 的 `getProvider()` 只看一个环境变量：

```go
switch strings.TrimSpace(os.Getenv("TJUCLI_MODE")) {
case "", "local", "direct":  // tjucli.NewProvider()
case "remote":               // remote.LoadConfig() → remote.NewClient(cfg)
default:                     // configuration_error
}
```

```text
tjucli course search "电路" --json
   │
   ├─ TJUCLI_MODE 未设置 / local / direct
   │     Provider ──HTTPS──▶ cs.tjuse.com  (/api/ 列表, /api/raw/ 下载)
   │     HTTP 超时 20s；单次目录响应上限 4 MiB；下载默认 64 MiB、上限 1 GiB
   │
   └─ TJUCLI_MODE=remote
         Client ──POST /v1/course/list | search | download──▶ tjucli-server
                  Authorization: Bearer <TJUCLI_TOKEN_FILE 内容>   127.0.0.1:18090
                  请求体 ≤16 KiB，未知字段拒绝；并发 4，超出回 429
                  服务端下载上限 64 MiB，响应头带 X-Content-SHA256
```

remote 这一侧可核的东西：

- `TJUCLI_SERVER_URL` 的校验：非 loopback 必须 HTTPS；不能带 userinfo、query、fragment、path 前缀。
- 令牌文件：必须是普通文件，Unix 下权限 `&0077 == 0`、≤4 KiB、≥32 字节、不含空白与控制字符；用 Lstat + Open + SameFile 挡 symlink 替换的 TOCTOU 窗口。
- 服务端 grants 文件：0600、≤64 KiB、只存 `token_sha256` 摘要、`subtle.ConstantTimeCompare` 比对，再查 `expires_at` 与 `scopes`，不匹配回 401/403。
- 远端失败不回退：`LoadConfig` 缺配置就是 `configuration_error`，`getProvider` 没有第二条路径；重定向也被拒，`doJSON` 见到 3xx 直接返回 `protocol_error: server attempted redirect`。

这里的摩擦要说清楚：

- `tjucli` 二进制里同时有两条路径。`DefaultBaseURL = "https://cs.tjuse.com"` 是编译进二进制的常量，把沙箱限制成 remote 靠的是注入环境变量，不是二进制里没有直连代码。`SKILL.md` 只能写“别在失败时切回 local”，这层限制实际落在沙箱 provisioning 上。
- `tjucli-server` 自己无法证明调用方物理上在某个沙箱里。`TOOL_SERVER.md` 的原话是这个需要可信签发与部署控制，TLS、真实后端签发、云网络与沙箱集成要单独验收。
- grant 不是一次性的。它在从 grants 文件里移除或过期之前一直有效，`run_id` 是绑定关系，不是消费计数。
- 签发方目前是个本地适配器：手工生成 token、手工写 grants 文件。产品后端的签发接口与沙箱生命周期不在这个服务里。

---

## 5. 下载：把落盘做成一件会拒绝的事

`course download` 是唯一会写文件系统的命令，防御堆在这里。

路径先规范化（`normalizeProviderPath`）：≤4096 字节、合法 UTF-8、不含反斜杠、不含控制字符、任何一段都不是 `.` 或 `..`，最后 `path.Clean("/" + value)`。

目标文件：

- standalone 用 `os.Lstat` 判断目标是否存在，已存在（软链接也算存在）就返回 `target_exists`；临时文件用 `os.CreateTemp` 建在目标同目录，失败时 defer 删除。
- remote 用 `os.OpenRoot(cwd)` 把根钉在工作目录，绝对路径必须能 `filepath.Rel` 回到 cwd 内，否则 `target_outside_workspace`；临时文件 `O_RDWR|O_CREATE|O_EXCL`、8 字节随机后缀、0600。

下载过程中：

- 重定向最多 5 跳，每跳必须 HTTPS，host 必须在允许集合内：base host、`cs.tjuse.com`、`onedrive.live.com`、`*.microsoftpersonalcontent.com`、`*.files.1drv.com`、`*.storage.live.com`。
- `Content-Type` 是 HTML 就拒绝，避免把一个登录页当成文件写进工作区。
- 先看声明的 `Content-Length` 是否超限，再 `io.Copy(..., io.LimitReader(body, maxBytes+1))`，抄完比对实际字节数与声明值。
- 服务端下载上限 64 MiB，即使 standalone 本地允许到 1 GiB。
- remote 额外要求 `Content-Length` 必须存在、`X-Content-SHA256` 是 64 位小写十六进制，落盘前比对摘要，不符回 `protocol_error: checksum mismatch`。

落盘：

- 用 `os.Link(temp, target)` 发布，不是 rename。目标已存在时 link 失败，映射成 `target_exists`，路径上不会覆盖任何东西。
- 发布失败或中途失败，临时文件都删掉，不留半截文件。
- 成功返回 `local_path`、`bytes`、`sha256`。standalone 的 sha256 是算给自己看的，没有可比的声明值；只有 remote 模式拿它做校验。

错误文案全是固定字符串：上游地址、临时签名 URL、响应体都不进 error。remote 的 `parseErrorResponse` 还有一层白名单，服务端返回的消息不会被原样透传。

---

## 6. 有界搜索

`course search` 是大小写不敏感的课程名匹配，只在根目录翻页，不递归，不看文件内容。`SearchMeta.scope` 固定是 `course-catalog`。

边界：

- 默认 20 页 / 50 条，硬上限 100 页 / 1000 条，四个常量在 `types.go`。
- 命中数达到 `limit` 就停下并置 `incomplete = true`；页数跑满而游标还在，同样置 true。
- 上游重复同一个游标会报 `protocol_error`，不会死循环。
- 单次目录响应上限 4 MiB，游标长度上限 8192 字节，直连 provider 的 HTTP 超时 20 秒。

`incomplete` 是给 Agent 看的，不是装饰。`SKILL.md` 写着：结果不完整时要么报告限制，要么在允许范围内加大，不要因为一次有界搜索就声称“没有这门课”。

---

## 7. 还没做完的

- Pi 运行时没接上。`cli/README.md` 写 product runtime integration is still pending，`TOOL_SERVER.md` 写 HTTP 服务是 integration building block、产品侧 Pi 与云沙箱执行仍未完成，`SKILL.md` 也明说装了这个 Skill 不等于产品 Pi 集成完成。
- 校园能力只有课程目录一项。课表、成绩、校园卡都在 Coverage gaps 里，不是待合并的分支，是没写。
- grants 签发方没实现。
- `capabilities` 的 `provider` 字段写死 `"public-course-sharing"`，而 `CapabilitiesResult` 的注释说它是 local 或 remote。注释是旧的，输出是权威，这是个还没收拾的不一致。
- `cli/README.md` 说 Requires Go 1.26+，`cli/go.mod` 写的是 `go 1.27.0`。以 go.mod 为准。

---

## 8. 最后

`tjucli` 里可以指到行的约定只有几个：一个信封结构、两个退出码、一次调用一个进程、一个 `os.Root` 边界、一次 `os.Link` 发布。

`cli/go.mod` 除了 module 和 `go 1.27.0` 没有别的行，没有 require 段，所以“没有第三方依赖”是构建系统的事实。它现在能做的事只有一件，那件事的每一步都有对应代码和测试；其余的都写在 Coverage gaps 里。
