---
title: 《为什么我们选择 Pi 作为 Agent 底座》
description: 一次运行时选型记录：今天产品里跑的是 Go 里一个四轮工具循环，为什么它长不成执行环境，为什么没用 LangChain/LangGraph，以及接 Pi 之前钉死的验收项。产品执行链仍未接通。
---

# 《为什么我们选择 Pi 作为 Agent 底座》

先把现状说清楚，免得后面被误读：底座选了 Pi，接入约束已经钉死，执行链还没接通。没起过沙箱，没跑过一次真实 run。这篇能拿出来的是一份约束清单和几段已经落地的代码，不是上线公告。

---

## 1. 今天产品里真正在跑的那段循环

登录后的 `/workspace` 里，打开一个智能体条目就是一次会话。它今天的全部自主能力来自 Go API 里的这个循环：

```go
// backend/internal/library/handler.go
for round := 0; round < 4; round++ {
    msg, cerr := h.router.complete(ctx, target, history, true)
    // ...
    if len(msg.ToolCalls) == 0 {
        break
    }
    tools := h.runTools(session.Identity.ID, entry.LibraryID, msg.ToolCalls)
    history = append(history, toOpenAI(tools)...)
}
```

给模型的工具只有四个，schema 硬编码在 `writeTools()` 里：

| 工具 | 参数 |
| --- | --- |
| `list_tree` | 无 |
| `create_entry` | `parent_id`、`kind`（`note` / `agent` / `work_env`）、`title`、`body` |
| `update_entry` | `id`、`title`、`body`、`parent_id` |
| `delete_entry` | `id` |

参数里没有路径，没有命令，没有 URL。每条工具调用的返回值是一段 JSON 字符串，直接回到上下文。四个具体上限：

- 一个请求最多 4 轮工具调用，整个循环套在 `context.WithTimeout(r.Context(), 40*time.Second)` 里；
- 上游响应体读 `io.LimitReader(res.Body, 1<<20)`，1 MiB，超出部分不存在；
- 一条消息上限 `MaxMessageRunes = 8000` 字符，请求体 16 KiB；
- 走产品 NewAPI 时按账号计每日额度（`NEWAPI_DAILY_QUOTA`，默认 20），用满返回 `429 quota_exceeded`。

模型调用本身是非流式的：一次 POST，读一个 JSON，取 `choices[0].message`。没有 SSE。

用户自填上游时 `resolve()` 返回 `Source = "custom"`，请求改走 `userClient()`：`DialContext` 里解析全部 A/AAAA，拒绝回环、私有段（含 `100.64/10`、`198.18/15`）、链路本地、未指定与多播地址，以及云元数据主机名和 `.localhost` / `.local` / `.internal` 后缀；重定向逐跳重新校验，`len(via) >= 3` 直接拒绝，也就是最多跟两跳。产品自己的 NewAPI 不走这条通道。

最后是 `internal/run`。Run 记录有完整状态机（`queued` / `running` / `succeeded` / `failed` / `cancelled`，终态不可逆），`FileStore` 与 `PGStore` 两个实现都在，`UpdateRunStatus` 只允许合法转移。但没有东西去驱动它，没有执行引擎写下第一个 `running`。这一层就是「记录已就位、执行未接通」的字面意思。

---

## 2. 这段循环为什么长不成执行环境

不是写得差，是它的形状定死了上限。想加一个能力，就得在 Go 里加一段 schema、加一个分支、重新编译重启。而 `execTool` 的每个分支都是在当前进程里同步调一次 store：

```go
func (h *Handler) execTool(ownerID, libraryID, name, rawArgs string) string {
    switch name {
    case "create_entry":
        e, err := h.store.CreateEntry(ownerID, libraryID, parent, kind, title, body)
        // ...
    }
}
```

没有 ctx，没有子进程，没有工作目录，没有输出上限的概念，也没有取消路径。文件、shell、git、长任务里没有一个能靠「再加一个 tool」装进来，它们要的是进程和文件，不是更多工具注册。

真正需要的东西是另一套，两边的差异可以一条条列出来：

| | 今天的 Go 循环 | 要接的执行面 |
| --- | --- | --- |
| 会话状态 | PostgreSQL 里的消息记录，含 `ToolCalls` | SDK 的 session（候选用 `SessionManager.inMemory`） |
| 工具来源 | 编译期固定的 4 个函数 | 默认 read/bash/edit/write + 显式加载的 Skill |
| 工作目录 | 无 | `/workspace` |
| 取消 | 只有 40 秒超时 | `session.abort` |
| 事件流 | 无 | `session.subscribe` |
| 输出上限 | 上游 1 MiB、消息 8000 字符 | 执行侧另行定义 |

Chatbox 与 Harness 的差别不在「回答」和「执行」这两个词上，就在这张表的两列：一边是函数调用表加一段会话记录，另一边是有进程、有文件、有生命周期事件、中途能被叫停的一次运行。表右列全部来自还没核过的候选接口，第 4 节会说清它没被核到什么程度。

检索层与知识引擎都不在这件事里。`backend/internal/search` 是独立的 MeiliSearch 客户端（未配置或不可用时返回明确错误，不挡主流程），WeKnora 是独立的知识引擎，两者和这个循环合不合并没有关系。

---

## 3. 为什么不是 LangChain 或 LangGraph

这一节可核的部分只有一条：四个仓库的依赖清单里没有它们。后端 `require github.com/jackc/pgx/v5 v5.11.0` 加五个 indirect；`cli/go.mod` 只有一个 `go` 声明，零第三方依赖；crawler 是 Bun 加 S3 SDK 加 cheerio；docs 侧是 Next 与 Fumadocs。仓库里没有一段被删掉的适配代码，也没有任何依赖痕迹能证明我们试过它们。原先那句「经过广泛评估后放弃」来自记忆，不是仓库能证的东西。

真实的理由要平得多。这一层要提供的接口就那几样（下一节），而它们定位里主打的编排、检索链、观测三块，我们要么已经有了（调度在 Go、检索在 MeiliSearch 与 WeKnora、日志和 CI 在 Actions），要么明确不想要：把四个工具的调用关系表达成一张图，收益是负的。

还有一个更土的考虑，这一段循环是十几行。

---

## 4. 接 Pi：钉下来的是约束，不是 API 文档

候选接口来自已安装 SDK 的调研记录（`private/plans/pi-bootstrap-follow-up.md`）：

```text
@earendil-works/pi-coding-agent 0.85.1
createAgentSession
ModelRuntime
SessionManager.inMemory
SettingsManager.inMemory
session.subscribe
session.abort
```

这是候选，不是契约。动手写代码前必须重新读装好的 SDK 文档，对着钉住的包逐个核对签名。这串名字现在只证明一件事：我们要的接口面有多大——一个会话、一个模型运行时、两个 in-memory store、一条事件流、一个取消调用。

归属也已经划开：runtime 代码属于私有后端组件，ops 负责把带版本的 CLI 与 Skill 打进沙箱镜像。为此不接受「把 Node bootstrap 测试塞进 CLI 仓库」这种回避归属定义的做法。

模型调用之前必须过的验收项，原文是断言式的：

1. 用显式 `ResourceLoader`，只返回产品 Skill 与既定 system context。`noSkills` 会不会顺带压掉 `additionalSkillPaths` 没有核实，不许假设这两个开关能组合出想要的结果。
2. 关掉宿主和项目的 extension、context、prompt template、model store、auth 发现。用显式的 in-memory store；`/dev/null` 不是「所有发现路径都查过了」的万能替身。
3. cwd 设成 `/workspace`，但不把 cwd 和默认的 read/bash/edit/write 当文件系统安全边界。边界只能来自挂载、权限和执行策略。
4. token 文件只解决「密钥不进命令行参数」，不解决「有 shell 的 Agent 读不到它」。要限权、设有效期、过滤出站事件，并且真做一次故意读密钥的测试。仅凭环境供给推不出「绝不泄漏」。
5. 模型与云凭据必须由产品下发，不允许静默回落到开发者全局认证。

Skill 一侧的口径同样收紧了。`cli/skills/tjucli/SKILL.md` 自己写着：装了这个 Skill 不等于产品 Pi 已经接通；远程模式必须使用运行时注入的凭据文件，不许读它、打印它、改端点，也不许切回本地模式绕过鉴权。AGENTS.md 的要求是「必须显式加载进产品运行时，不是只装在开发者全局 Pi 里」。

---

## 5. 没做完的、被推翻的、还没定的

1. 产品执行链未接通。没起过沙箱，没跑过一次真实 Pi run，live Pi / 模型 / 沙箱执行均未验证。仓库里唯一的「运行时」是第 1 节那个四轮循环。
2. 运行时底座被改过一次。有一段时间的既定方向是 omp 当默认运行时，2026-09-17 改回 Pi：产品 Agent 与采集处理都以 Pi 为执行面，omp 不再是默认执行面。
3. 模型凭据的下发路径没定。「由产品下发」是定的，「直连 NewAPI 还是复用 Go 转发器」没有记录。没定就是没定，不在这里替它挑一个。
4. 沙箱与对象存储的落点换过。早先方案是腾讯云 Agent Sandbox 加 COS，当前文档口径是 EdgeOne Makers 沙箱加 对象存储（桶 `tjuclaw-files`），而 Go 与 crawler 还没改走 对象存储。这决定了 Pi 的工作目录以后长什么样，但不是这篇要下结论的部分。
5. 沙箱里的 git 只能当步粒度。Makers 文档写的是 `commands.run` 每次都起新进程、不保留 cwd 与环境变量，`persist()` 默认排除 `.git`（连同 `node_modules`、`.venv`、`dist`）。所以恢复回来的是「有工作树、没有历史」的目录，工作区恢复只剩 clone 一条路；沙箱镜像里有没有 `git` 还没探测过，而设计结论不依赖这次探测——沙箱里的 git 只提供步粒度，权威在服务端。

---

## 6. 那张图怎么读

![从 Chatbox 到 Agent Harness 架构范式演进图](./images/chatbox-vs-agent-harness.webp)

图是设计意图，不是现状快照。右半边里，`Filesystem` 与 `Shell / CLI` 对应的是第 4 节那条「cwd 不是边界」的约束；`Search (tjucli)` 对应 `cli/skills/tjucli/`；`Knowledge Base (WeKnora)` 与 `Object Storage (对象存储)` 是外部系统。左半边那套 RAG / Tools / Workflow / Tracing 的堆叠，就是我们不打算再往上加的东西。

```text
用户目标
   ↓
Model（凭据由产品下发；签名待核）
   ↓
Agent Loop（多轮，可订阅、可中断）
   ├─ Tool Call ──► Environment（沙箱内 /workspace，真实 shell）
   │                    ↓
   └─ Observation ──────┘  下一轮
   ↓
产物与条目写入：权威在服务端，不在沙箱
```

---

## 7. 现在能核到的最小闭环

一条会话消息 → Go API → 公网 HTTPS 的 OpenAI 兼容上游 → 最多四次工具调用 → 条目落 PostgreSQL。这是已经跑起来的部分，也是写这篇时唯一拿得出来的部分。

Pi 合不合适，要等第一个真实 run 跑完才知道。在那之前，这份记录就是全部：六个候选接口名、五条模型调用前的验收、一条「装了 Skill 不等于接通」。
