---
title: 《智能体的代码执行、文件系统，与隔离沙箱》
description: 沙箱里的 Pi 还没有跑起来。这篇写已经落地的部分——tjucli 的 remote 模式与 tjucli-server 的按次授权，每一个数字都能指到代码行——以及其余仍是目标设计、尚未验收的部分。
---

# 《智能体的代码执行、文件系统，与隔离沙箱》

先把状态说清楚：这条链上真正能跑的只有一段。

`tjucli-server` 有代码、有测试、有写在文档里的 HTTP 契约。沙箱那一侧——Pi 在隔离环境里执行、工作区落盘、产物归档——都还在计划和验收清单上。`CONTEXT.md` 的原话是「产品执行链仍未接通」，`cli/README.md` 写得更直白：

```text
The HTTP service is an integration building block; product Pi/cloud sandbox execution remains pending.
```

所以这篇分两半。前半是已实现的授权代理，每个数字都能在 `cli/` 里指到行。后半是未实现的沙箱，会说清楚哪一条是已核事实、哪一条只是计划。

---

## 1. 已经跑起来的一段

让沙箱里的 Agent 直接持有校园提供方的会话和地址，等于把长期凭据交给一段可能被提示词注入的代码。已落地的做法是：沙箱只拿一个不透明令牌，通过一个 HTTP 服务间接调用，校园侧凭据不下发。

```text
沙箱内                                    核心主机

$ tjucli course search "电路" --json
   │  TJUCLI_MODE=remote
   │  从 TJUCLI_TOKEN_FILE 读令牌（不放命令行参数）
   │  POST /v1/course/search
   │  Authorization: Bearer <opaque token>
   │
   └───────────────►
                   tjucli-server   127.0.0.1:18090
                   GET  /healthz          未鉴权
                   POST /v1/course/list
                   POST /v1/course/search
                   POST /v1/course/download
                   └─ 三条 /v1 路由都要求 course:read
```

客户端的开关是 `TJUCLI_MODE`，空值等同于 `local`/`direct`，独立使用不受影响；产品沙箱必须显式选择 `remote`。`remote` 下任何失败都不会回落到直连提供方：远端错误只报错，不改用本地提供方重试。

`version`、`--help` 这类本地元数据命令不需要服务凭证。

---

## 2. 授权：服务端只存摘要

令牌本身是外部生成的随机不透明串，要求至少 32 字节熵。原始令牌写在单独的私有文件里，只供那一次执行使用；`tjucli-server` 侧只存它的 SHA-256 摘要。这个分工决定了凭据入库的形态：

```json
{"grants":[{
  "token_sha256":"<sha256 of a randomly generated opaque token>",
  "run_id":"<32 lowercase hex characters>",
  "expires_at":"<RFC3339 expiry>",
  "scopes":["course:read"]
}]}
```

`TJUCLI_GRANTS_FILE` 指向的这个文件，`cli/internal/toolserver/authorizer.go` 会逐条校验，不合格就整份拒绝：

| 要求 | 值 |
| --- | --- |
| 文件类型 | 普通文件（非符号链接、非设备） |
| 权限 | 恰好 `0600` |
| 大小 | ≤ 64 KiB（`MaxGrantsFileBytes`） |
| JSON | 严格模式，禁止未知字段与尾随内容 |
| `token_sha256` | 64 位小写十六进制 |
| `run_id` | 32 位小写十六进制，同一文件内不得重复 |
| `expires_at` | RFC3339 |
| `scopes` | 不得为空数组，元素不得为空串 |

权限与类型检查走的是 `Lstat` + `Open` + `Fstat`，再用 `os.SameFile` 确认打开前后是同一个 inode，避免校验通过之后文件被替换。

鉴权本身按固定顺序，任何一步失败都不放行：

```text
Authorization: Bearer <token>
   │
   ├─ token 为空 ──────────────────────► 401 unauthorized
   ├─ 每次请求重新读 TJUCLI_GRANTS_FILE
   │     读不出、格式错、权限错 ────────► 503 service_unavailable
   ├─ sha256(token) 与每条 grant 比对
   │     使用 subtle.ConstantTimeCompare
   │     循环不 break，命中后仍比完所有条目
   │     无匹配 ──────────────────────► 401 unauthorized
   ├─ expires_at 已过期或无法解析 ─────► 401 unauthorized
   ├─ scopes 不含 course:read ────────► 403 forbidden
   └─ 通过，deadline = min(120s, grant 剩余寿命)
```

三点值得单独说。

**每次请求重新读文件。** 删掉一条 grant 就立即挡住后续请求，不需要重启服务、也没有内存缓存窗口。过期时间则是另一条界限：它同时约束在途请求，因为单个请求的读写 deadline 会被夹到 `min(默认超时, grant 剩余寿命)`。

**失败是关门的，不是开门的。** 授权文件读不出来时返回 `503 service_unavailable`，不会退回「放行」或「用上一次读到的缓存」。比对用的是常量时间函数，且命中后不提前退出循环，位置信息不会从耗时上漏出去。

请求里没有 owner，也没有 run_id。`CourseDownloadRequest` 只有 `path` 和 `max_bytes` 两个字段，注释写得很直接：`no caller output/filesystem path is accepted`。`run_id` 是授权记录上的标识，用来把这次授权对上某个 Run，它不参与鉴权——服务端也不打算从请求里接受调用方自报的身份。

客户端一侧同样有约束，读的是 `cli/internal/remote/client.go`：

- `TJUCLI_TOKEN_FILE` 必须是普通文件，且 `perm & 0077 == 0`，组和其他用户不可读；大小 ≤ 4 KiB，令牌长度 ≥ 32 字节、不含控制字符与空格。
- `TJUCLI_SERVER_URL` 不得包含用户信息、query、fragment 或路径前缀；非回环主机必须 `https`。
- 配置错误统一归为 `configuration_error`，错误信息里不出现 URL、令牌或文件路径。

---

## 3. 有界：一张常量表

`cli/internal/toolserver/types.go` 里的六个常量定义了服务的形状：

```go
DefaultAddr             = "127.0.0.1:18090"
MaxRequestBodyBytes     = 16 * 1024       // 16KiB
MaxGrantsFileBytes      = 64 * 1024       // 64KiB
MaxDownloadBytes        = int64(64 << 20) // 64MiB
DefaultConcurrency      = 4
DefaultRequestTimeout   = 120 * time.Second
RequiredScopeCourseRead = "course:read"
```

它们各自对应一个真实的拒绝路径：

| 触发 | 响应 |
| --- | --- |
| 并发已满（信号量为 4，三条 `/v1` 路由共用同一个信号量） | `429` `busy` |
| 请求体超过 16 KiB | `413` `payload_too_large` |
| `Content-Type` 不是 `application/json` | `415` `unsupported_media_type` |
| `max_bytes` 超过 64 MiB | `400` `invalid_argument` |
| 授权文件读不出或不合规 | `503` `service_unavailable` |
| 上游提供方错误 | `502` `upstream_error`，原始细节被替换成固定文案 |

并发限制是拒绝而不是排队：满员时立刻返回 429，不占住连接等待。通道缓冲直接由 `MaxConcurrency` 决定，没有额外的队列层。HTTP 服务器层面另有 `ReadHeaderTimeout: 10s`，读写超时按 `DefaultTimeout + 15s` 设置，空闲连接 120 秒回收；收到 `SIGINT`/`SIGTERM` 后走 10 秒的优雅关闭，然后删掉自己的 spool 目录。

下载路径上的 SHA-256 用的是同一份摘要思路，只是方向相反：

1. 服务端为每个请求建一个 0700 的隔离 spool 目录，把上游文件落成 `payload.bin`；
2. 校验实际大小不超过 `max_bytes`，再对整个文件算 SHA-256；
3. 流式返回，响应头带精确的 `Content-Length` 与 `X-Content-SHA256`；
4. CLI 侧核对实际字节数与声明长度、实际摘要与 `X-Content-SHA256`，全部对上之后再用 `root.Link` 建立硬链接发布，最后删掉临时名。

64 MiB 这个上限来自服务端，客户端的 `max_bytes` 也被限制在 64 MiB 以内。单机直连模式的上限是另一回事：`cli/internal/tjucli/types.go` 里 `MaximumDownloadBytes` 是 1 GiB，那是给开发者本地用的，沙箱里不该出现。

---

## 4. 唯一的落盘防线在 CLI 自己手里

下载产物写到哪、能不能覆盖、中途失败会不会留半截文件，这几件事今天只有一处实现，在 `cli/internal/remote/client.go` 的 `Download` 里：

- 用 `os.OpenRoot(cwd)` 打开当前工作目录作为根，所有写入都经过这个 root，路径穿越与符号链接逃逸由 `os.Root` 拒绝；
- 绝对路径会被换算成相对 cwd 的路径，算不出来或落在 cwd 之外就返回 `target_outside_workspace`；
- 目标文件已存在直接报 `target_exists`，不做覆盖；发布用硬链接而非重命名，发布前先 `Lstat` 确认目标不存在，链接失败时再查一次；
- 临时文件用 8 字节随机后缀命名（`.tjucli-dl-<hex>`），`O_EXCL` + `0600` 创建，发布前任何失败路径都会把它删掉；
- 响应必须是 `application/octet-stream`，缺 `Content-Length` 或 `X-Content-SHA256` 一律按协议错误处理；
- 重定向被整体拒绝，`CheckRedirect` 返回 `http.ErrUseLastResponse`，另有显式状态码检查再兜一次。

这段代码保护的是「CLI 在自己的 cwd 里写文件」这件事。它**不是**沙箱的文件系统边界。`private/plans/pi-bootstrap-follow-up.md` 把这一点写成了硬要求：

```text
Set /workspace as cwd, but do not treat cwd or the default read/bash/edit/write tools
as a filesystem security boundary. Actual restrictions come from sandbox mounts,
permissions and execution policy.
```

把工作目录设成 `/workspace` 是一条约定；真正拦得住 `cat /etc/passwd` 的是挂载与权限。

---

## 5. 沙箱执行链：目标与现状

`backend/internal/` 现在只有 `auth`、`task`、`run`、`library`、`search` 五个包，没有沙箱适配器。沙箱那侧目前是设计文档，不是代码。

计划里的职责边界（`private/plans/architecture-2026-09-09.md` §12）是：`tjuclaw-server` 唯一持有沙箱管控凭据与短效凭据签发权；沙箱不持云平台管理凭据、不持数据库连接串、不持身份服务管理密钥；它拿到的环境变量是 `TJUCLI_SERVER_URL` 加 `TJUCLI_TOKEN_FILE`，以及一个限额度、限任务用的模型令牌。文件拉取与产物提交由服务端派生路径，沙箱无法伪造或穿越。这份文档自己标注了性质：接口边界设计，不含生产代码变更。

Pi 的集成点也是候选而非结论。文档记下的候选 API 是 `@earendil-works/pi-coding-agent` 0.85.1 的 `createAgentSession`、`ModelRuntime`、`SessionManager.inMemory`、`SettingsManager.inMemory`、`session.subscribe`、`session.abort`，并明确要求落地前重读钉住版本的导出、逐个核对签名。

平台本身也没定。架构计划把腾讯云 Agent Sandbox 当作目标执行服务；`CONTEXT.md` 在 2026-09-15 把「云端轻量执行」定为 EdgeOne Makers，2026-09-19 记下 Makers 沙箱的已核事实——`commands.run` 每次都是独立新进程，不保留 cwd 与环境变量；`persist()` 归档上限 25 MiB，且默认排除 `.git`、`node_modules`、`.venv`、`dist`。腾讯云与 Makers 两边都没有实例跑起来。

### 未验证的部分

排名不分先后，每一条都是「写了但没测」：

1. **沙箱能不能访问到 `tjucli-server`。** 默认监听地址是回环 `127.0.0.1:18090`，非回环客户端需要一个可信 TLS 入口。沙箱容器内能否通过内网 HTTP 访问宿主机的 18090，或者必须走受控公网网关，是 `private/plans/archive-index-pipeline.md` 里列明的待核验项。
2. **服务不验证调用方真的在沙箱里。** `cli/TOOL_SERVER.md` 的原话是它不建立这个证明；那需要可信签发与部署控制配合。TLS、真实后端签发、云网络与沙箱集成都需要各自单独验收。
3. **授权是谁签发的。** 现在的 `TJUCLI_GRANTS_FILE` 是本地集成用的适配器；产品后端签发器与沙箱生命周期不在这个服务里。所谓「后端注入令牌、取消时删除 Grant」目前是设计，不是行为。
4. **凭据文件不等于防泄漏。** `pi-bootstrap-follow-up.md` 写得很清楚：令牌放文件而不是命令行参数只解决了参数可见性问题，**不能**保证一个有 shell 的 Agent 读不到这个文件或把它打印出来。所以要求是收紧 scope 与有效期、过滤出站事件，并且要写测试主动尝试泄漏测试密钥。
5. **输出上限、取消、事件脱敏都还没有实测。** 包括流式中途取消、工具执行中途取消，以及加载一份「必须保持未加载」的合成宿主 Skill 来验证资源加载器真的只加载了产品 Skill。
6. **live 执行未验证。** Pi、模型、沙箱三条都是。模型与云凭据必须由产品下发，不能静默回落到开发者机器上的全局凭据。

---

## 6. 工作区目录：全是计划

沙箱里的目录结构今天无处可查，因为沙箱没跑。计划稿里出现过两处描述：

| 来源 | 内容 |
| --- | --- |
| 架构计划 | 新沙箱把选定输入下载至本地 `/workspace`；依赖缓存与临时文件不默认持久化 |
| 资料库计划 §5 | `/workspace/libraries/<library-id>/` 存只读资料，`/workspace/personal/` 与 `/workspace/outputs/` 可写 |

其中「只读」那一栏有一句限定条件值得抄下来：只读应当由挂载或沙箱权限实现，而不是 `chmod` 之后仍然以 root 执行。

存储层的情况更清楚一些，因为它已经被改判过。2026-09-09 的架构计划以腾讯云 COS 为目标，并给出 `users/{owner_key}/workspaces/{workspace_id}/...` 这套服务端派生对象键。到 2026-09-15，`CONTEXT.md` 把对象存储定为 对象存储（桶 `tjuclaw-files` 与 `tjuclaw-crawler`），并写明不建腾讯云 COS。沙箱产物的归档路径没有随新决定重新设计，也没有实现。

---

## 7. 最后

今天这条链上能跑起来的东西是：一个监听 18090 的 Go 服务，一个容量为 4 的信号量，一个每次请求重读的 64 KiB 授权文件，以及 CLI 在自己 cwd 里的 `os.Root`。

沙箱那边还没有一行代码。
