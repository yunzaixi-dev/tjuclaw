---
title: 为什么我们把 Agent 的能力做成 CLI：tjucli 的设计
description: 反思复杂协议与臃肿 RPC 框架的过度封装——TJUClaw 为什么把校园课程资料与公开知识检索沉淀为符合 Unix 哲学的 tjucli，以及它的确定性 JSON 信封、三种运行模式与防御式下载。
---

# 为什么我们把 Agent 的能力做成 CLI：tjucli 的设计

给 Agent 接工具的方式有很多：Function Calling、各类框架的动态工具、Model Context Protocol，以及各种自研 RPC 网关，几乎每隔几个月就多出一种。

在把校园课程资料接给 Agent 的过程中，我们反复比较之后，得出了一个有点朴素的结论：

> **给运行在沙箱里的智能体赋予能力，最好的形态往往不是一套网络协议或 Python 类库，而是一个符合 Unix 哲学的命令行工具。**

这正是 `tjucli` 的初衷：把公开课程资料的浏览、搜索、下载，以及校园公开知识库的检索，收敛到一个单二进制可执行文件里。

---

## 1. 为什么不是 MCP 或 Python SDK？

| 方案 | 运行机制 | 主要问题 |
| --- | --- | --- |
| Python SDK | 模型在执行环境里 import 专用库 | 污染执行环境；依赖版本冲突；模型容易臆想不存在的方法 |
| MCP | 长连接 JSON-RPC 进程间通信 | 沙箱内需要常驻服务；挂起与重连排查成本高 |
| 远程 Function Calling | 每一步都经调度中心代理 | 往返延迟多；容易把平台令牌暴露给沙箱或提示词 |
| **独立二进制 CLI** | **子进程一次性唤起** | **零运行时依赖；毫秒级启动；输入输出自成文档；标准流天然隔离** |

CLI 的收益来自三个朴素的事实：

1. **Unix 哲学**：沙箱里的 Agent 天生会用 Bash。调用一个可执行文件并读取 `stdout`，是操作系统最底层、最稳健的原语；
2. **人和模型用同一种方式调试**：开发者在终端敲 `tjucli course search "电路"` 就能看到结果；模型传错参数时，明确的退出码和 `stderr` 提示能直接引导它自我修正；
3. **轻量**：Go 编写，编译为静态单二进制，可以直接放进任何轻量级 Linux 沙箱。

需要说明的是，这并不意味着所有能力都必须走 CLI。在没有 Shell 的产品会话里，Go API 以原生工具调用提供校园工具、公开知识检索与看图；两边遵循同一套约定：**输入有界、输出是确定的结构、错误是稳定的机器码。** CLI 是这套约定在「有 Shell 的沙箱」里的形态。

---

## 2. 命令面

```text
tjucli version      [--json]
tjucli capabilities [--json]          列出当前模式下可用的能力
tjucli course ls [PATH] [--cursor C]  浏览公开课程目录的一页
tjucli course search QUERY [--max-pages N] [--limit N]
tjucli course download PATH --output FILE [--max-bytes N]
tjucli knowledge search QUERY [--limit N] [--source SOURCE]
```

`capabilities` 让 Agent 先问一句「我现在能做什么」，而不是靠试错发现某个子命令在当前模式下不可用。

`knowledge search` 检索的是公开校园知识库（WeKnora 混合检索），每条结果都带来源、分数、原文链接与简短摘录；`--source` 可以精确限定为某一个来源，例如 `college-arch`、`wepeiyang-lake-posts` 或 `public-course-sharing`。不加限定时，如果官方页面与论坛帖子得分接近，官方页面排在前面。

---

## 3. 协议设计：确定性 JSON 信封

当使用者是 LLM 时，命令行工具的输出绝不能是一段随意排版的文字，否则模型必须浪费注意力去切分行、提取字段。

所有子命令都支持 `--json`，并保证输出符合双信封契约：

```json
{
  "ok": true,
  "data": {
    "items": [
      { "name": "线性代数复习讲义.pdf", "path": "/courses/math/linear-algebra.pdf", "size": 4194304 }
    ]
  },
  "meta": { "pages_scanned": 3, "incomplete": false }
}
```

```json
{
  "ok": false,
  "error": { "code": "invalid_argument", "message": "path traversal is strictly forbidden" }
}
```

- **标准流分离**：过程日志、重试警告一律写到 `stderr`，`stdout` 只输出一个合法的 JSON 值；
- **有界输出**：课程搜索默认最多扫描 20 页、返回 50 条（硬上限 100 页、1000 条），目录响应最多读取 4 MiB，避免一个宽泛的查询撑爆模型上下文；
- **诚实的不完整**：扫描没有覆盖全部目录时，`meta.incomplete` 为 `true`，模型可以据此决定是否继续翻页，而不是把部分结果当成全部。

---

## 4. 三种运行模式

```text
                        tjucli
                          │
            TJUCLI_MODE 决定数据从哪里来
      ┌───────────────────┼────────────────────┐
      ▼                   ▼                    ▼
  standalone         knowledge-local          remote
  直连公开课程源      直连 WeKnora 知识库      只经 tool server
  个人电脑 / 调试     维护者本地检索验证        生产沙箱
```

1. **standalone**：不需要任何后端，个人电脑上即可浏览、搜索和下载公开课程资料；
2. **knowledge-local**：配置 WeKnora 地址与 Key 后直接检索知识库，主要用于维护者验证导入质量；
3. **remote**：生产沙箱里强制使用。所有请求都经由 tool server 转发，沙箱接触不到数据源的真实地址或任何密钥。每个 Run 获得一个随机高熵令牌，tool server 只保存其 SHA-256，用常量时间比较校验，并检查 `run_id`、过期时间与 scope（如 `course:read`、`knowledge:read`）。

**remote 模式从不回退到直连。** 令牌失效、网关不可达时，命令返回明确的错误，而不是悄悄换一条绕过授权的路径。

---

## 5. 防御式下载与原子落盘

`tjucli course download /path/to/file.pdf --output ./math.pdf` 看起来简单，但朴素的实现很容易引发越权覆盖、竞态或半截文件。

1. **拒绝路径穿越与覆盖**：规范化输入路径，拦截 `../`、反斜杠、控制字符和非法 UTF-8；拒绝写入已存在的文件，拒绝写入符号链接；远程模式下，下载只能落在 CLI 工作区内；
2. **临时文件与上限**：先写入同目录的隐藏临时文件，实时校验字节数；超过上限（默认 64 MiB，硬上限 1 GiB）或网络中断时，立即删除临时文件；
3. **原子发布**：只有完整下载且校验通过后，才通过原子重命名发布为目标文件。

---

## 6. 总结

`tjucli` 没有什么新概念：确定的 JSON 信封、诚实的「不完整」标记、远程模式下从不回退到直连、原子化的文件落盘，再加上一个零依赖的静态二进制。

这些约束让它对人和对模型都一样好用：人可以在终端里直接调试，模型拿到的输出结构永远一致，出错时也只会看到一个稳定的错误码，而不是一段需要猜测的堆栈。
