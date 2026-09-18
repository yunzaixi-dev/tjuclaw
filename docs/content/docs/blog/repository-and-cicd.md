---
title: 《从代码仓库到持续交付：TJUClaw 的仓库划分与 CI/CD》
description: 多技术栈异构、公私仓库混合、跨平台四端构建与比赛合规镜像——深度解析 TJUClaw 从 Git 子模块拓扑到持续集成流水线的交付工程实践。
---

# 《从代码仓库到持续交付：TJUClaw 的仓库划分与 CI/CD》

在构建一个涵盖“跨端客户端（Web / Linux / Windows / Android）、Golang 业务后端、分布式爬虫、校园专属 CLI 工具链以及 Next.js 文档站”的复杂系统时，项目初期面临的最大挑战往往不仅是业务逻辑本身，而是**工程结构的组织方式与持续交付（CI/CD）体系的设计**。

如果采用单一巨石仓库（Monorepo），不仅跨语言依赖管理（pnpm、Go Modules、Bun、Cargo/Tauri）容易相互冲突，还受制于竞赛评审合规、代码可见性划分（开源客户端与私有后端）等外部约束；而如果完全拆散为各自独立的孤岛仓库（Multi-repo），则组件之间的版本契约与集成测试将变得极难追溯。

TJUClaw 最终探索出了一套**“以私有集成仓库为主干、强版本契约 Git Submodule 为纽带、单向受控镜像与两步构建流水线”**的持续交付工程架构。

---

## 1. 仓库划分全景与可见性边界

TJUClaw 由一个主集成仓库与四个核心组件仓库协同构成。每个仓库各司其职，拥有完全独立的版本生命周期与技术栈环境：

| 仓库 | 可见性 | 核心技术栈 | 核心职责 |
| :--- | :--- | :--- | :--- |
| **`tjuclaw`** (主集成仓库) | Private | Taskfile, Next.js (Fumadocs), Ansible | 版本集成中枢、精确组件 Gitlink 锚定、技术文档、端到端集成测试、GitLab 镜像与 Release 发布 |
| **`tjuclaw-client`** (`frontend/`) | Public | React 19, Vite, Tailwind v4, Tauri v2 | 统一跨端交互界面、UI 与工作区组件回归、四端（Web / Linux / Windows / Android）打包 |
| **`tjuclaw-server`** (`backend/`) | Private | Go 1.27 (stdlib net/http), PostgreSQL | 核心业务 API、ZITADEL / Cap 会话网关、任务隔离存储、鉴权与所有权校验 |
| **`tjucli`** (`cli/`) | Private | Go 1.27, CLI / Tool Server | 校园课程搜索、公共数据 CLI、Pi Agent 原生工具标准抽象（JSON Envelope） |
| **`tjuclaw-crawler`** (`crawler/`) | Private | Bun 1.3.14, PostgreSQL, 对象存储 | 校园多渠道高频爬虫、PII 规则脱敏、文档归一化、RSS 与增量更新回放 |

```text
                  +-----------------------------------------+
                  |        yunzaixi-dev/tjuclaw             |
                  |        (私有集成中枢 / 主分支 release)     |
                  +----+----------+----------+----------+---+
                       |          |          |          |
         git submodule |          |          |          | git submodule
         (Pinned SHA)  |          |          |          | (Pinned SHA)
                       v          v          v          v
                  +---------++---------++---------++---------+
                  |frontend || backend ||   cli   || crawler |
                  | (Public)||(Private)||(Private)||(Private)|
                  +---------++---------++---------++---------+
                       |
                       | 单向代码镜像 / 状态回写
                       v
                  +-----------------------------------------+
                  |       GitLab Competition Mirror         |
                  |       (比赛评审镜像 / 离线安装包归档)        |
                  +-----------------------------------------+
```

这种设计的核心收益在于：
1. **依赖隔离**：根目录仅承载 Next.js 文档站与编排脚本；客户端拥有专属 `pnpm-lock.yaml`；后端与 CLI 采用独立 `go.mod`；爬虫拥有专属 `bun.lock`。没有任何两个子系统互相争抢全局包依赖。
2. **安全与最小特权**：客户端作为公开展示前端，代码完全脱敏且不包含任何服务端凭证；私有核心（API 与沙箱权限）受到严格的 SSH 访问密钥与 CI Deploy Token 保护。

---

## 2. 强版本控制与 Git Hooks 约束

在跨子模块的开发中，“Submodule 悬空（Detached HEAD）”或“版本号与 Git 标签不一致”是极为致命的隐患。TJUClaw 通过根目录下的 `scripts/` 工具链与严格的 Git Hooks 建立了强版本约束契约：

- **显式路径暂存（Explicit Staging）**：禁止盲目执行 `git add .`。开发者修改组件后，必须逐个路径显式暂存。
- **语义化提交规范**：提交信息必须严格遵循带有 Emoji 与版本号的格式：
  ```text
  EMOJI [vMAJOR.MINOR.PATCH] type(scope): summary
  ✨ [v0.0.26] feat(pipeline): introduce qwen embeddings
  ```
- **版本号同态校验**：提交时，钩子会自动检查暂存的 `package.json`（或各组件版本声明文件）中的 `version`，必须与提交主题中的 `[vX.Y.Z]` 严格保持完全一致。

---

## 3. 持续集成体系 (CI)

整个 CI 流水线基于托管构建机运行，依托根目录统一的 `Taskfile.yml`（在 Agent 会话中统一使用 `rtk task` 执行），将复杂的跨语言检查规整为确定性的入口：

```text
Commit Push (release / dev / tag)
   │
   ├─► 1. 源码镜像 (Mirror Job)
   │      └── 严格检查 release 分支与完整 tag ref，单向同步至 GitLab 比赛仓库
   │
   ├─► 2. 组件检出与白名单环境预热 (Setup)
   │      ├── 注入只读 Deploy Key 检出各个私有 Submodule
   │      ├── 启动 Docker ephemeral PostgreSQL 17 服务容器 (供爬虫与 API 测试)
   │      └── 安装 ffmpeg、poppler-utils、webp、python3 等多媒体与脱敏依赖
   │
   ├─► 3. 便携式多语言静态与类型检查 (Check)
   │      ├── Go API & CLI: go vet, staticcheck, race test
   │      ├── Client & Docs: TypeScript strict check, ESLint
   │      └── Crawler: Bun test, schema validation, PII regression check
   │
   └─► 4. 真实端到端集成测试 (Integration Test)
          └── 拒绝 Mock！拉起真实的 Kratos/ZITADEL + Cap + Mailpit 容器进行全流程验收
```

### 为什么坚持“拒绝 Mock”的真实集成测试？
在很多轻量级项目中，认证逻辑常常只用 Mock 模拟一个 200 OK 的响应。然而真实世界的 Bug 往往出在：Cookie 的 `HttpOnly` / `SameSite` 跨域表现、反向代理层剥离 `/api` 前缀的边界、邮件验证码生成与核销的原子性、以及图形验证码 Token 的单次消费逻辑。

TJUClaw 的 CI 测试中包含 `task auth:test`：流水线会启动真实的认证中心、Valkey 缓存与无头浏览器，在完全受控的容器网络中模拟真实用户的登录、发信、截获与任务保存，只有真实交互通过，才能打上通过标记。

---

## 4. 跨平台四端构建与“两步发版”机制

TJUClaw 客户端面向校园多端场景，支持四大操作系统平台（Web、Linux amd64、Windows x64、Android arm64）。如果每一次服务端小改动都触发四端打包，将耗费数十倍的无谓算力。

为此，TJUClaw 设计了**职责解耦的两步发布流程（Two-Step Release Workflow）**：

```text
Step 1: 客户端仓库触发打包 (Client Release)
   │
   ├─► 针对特定 SHA 构建 Linux (.deb)、Windows (.exe)、Android (.apk)
   ├─► 对构建产物进行 SHA-256 完整性哈希校验
   └─► 上传至 GitLab Generic Package Registry 并签发 manifest.json
         │
Step 2: 主集成仓库综合发布 (Integration Release)
   │
   ├─► 核对集成 CI 状态与当前锁定的 Submodule Gitlink
   ├─► 下载并二次校验客户端 Manifest 与下载摘要
   ├─► 提取纯净的各组件源码快照（生成附带 SOURCE.json 溯源信息的 tar.gz）
   └─► 统一向 GitLab Release 挂载完整安装包、源码包与 SHA256SUMS.txt
```

这种两步机制确保了：
1. **构建过程不可篡改**：所有安装包都有唯一的 SHA-256 哈希保障，并在 Release 页面公开对齐；
2. **可溯源性**：评审专家下载源码包时，解压即可获取所有组件与当时精确的 Git 提交快照；
3. **极高迭代效率**：前端界面修改只跑前端打包流水线，核心架构升级只跑集成回归，边界清晰，分工明确。

---

## 5. 云边协同部署：从 EdgeOne 到边缘网关

对于在线服务的持续交付，系统采用分层分流的云边协同策略：
- **静态前端与文档站**：编译为纯静态产物（`output: 'export'`），自动化推送到腾讯云 **EdgeOne** 边缘安全加速平台。利用边缘节点的全局缓存，校园用户可以在数毫秒内完成首屏文档与客户端 HTML 的极速加载；
- **动态后端 API 网关**：针对 `/api/*` 的动态事务请求，EdgeOne 规则引擎自动反向代理回源至核心云主机上的 Go 原生服务容器；
- **配置与数据隔离**：运维配置完全通过 Ansible Playbook 编排落地，服务器敏感凭据与数据库持久化卷严格挂载在宿主机的安全隔离目录，杜绝代码仓库对生产敏感数据的任何直接依赖。

---

## 总结：基础设施也是核心生产力

一个真正经得起生产考验与竞赛评审的智能体项目，绝不仅仅是几段提示词或几个模型接口的拼凑。

从严谨的 Git 仓库划分、强版本控制、拒绝假冒模拟的真实 CI 验证，到跨平台四端的两步打包与云边协同部署，TJUClaw 构建起了一套**透明、可追溯、安全且极度工程化**的交付体系。这套稳固的基础设施底座，不仅赋予了我们高频迭代的底气，也为后续复杂智能体能力的稳定挂载与演进提供了最坚实的保障。
