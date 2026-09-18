<!-- AUTO-GENERATED from docs/content/docs/index.md. DO NOT EDIT DIRECTLY. -->
<!-- Run `task docs:sync` or `task docs:design` to regenerate. -->

> **提示**：关于 TJUClaw 的完整系统设计、数据管道、沙箱安全、原生 CLI 与跨平台客户端实现等详细技术细节，建议访问官方文档站查阅：[https://tjuclaw.cloud/](https://tjuclaw.cloud/)（兼容镜像：[https://wiki.tjuclaw.cloud/](https://wiki.tjuclaw.cloud/)）。

# 介绍 TJUClaw

TJUClaw 是面向天津大学校园场景优化的智能体（AI Agent）平台。平台围绕校园学习与日常事务场景设计，通过将校园公开信息与高频服务抽象为确定性工具接口，配合隔离执行环境，帮助学生完成课程资料检索、空闲教室查询等任务并交付可校验的结果。

---

## 快速开始

可以通过以下方式直接体验平台功能：

- **Web 端**：访问 [https://tjuclaw.cloud/](https://tjuclaw.cloud/)，直接使用工作台创建和管理任务；
- **原生客户端**：可在首页获取对应平台的安装包：
  - **Windows**: 64 位安装程序（`.exe`）
  - **Linux**: Debian / Ubuntu 软件包（`.deb`）
  - **Android**: 安装包（`.apk`）

> 本地源码调试与完整开发环境搭建步骤，请参考：[快速开始指南 (Quickstart)](https://tjuclaw.cloud/docs/quickstart)。

---

## 模块划分与仓库矩阵

> **主要仓库说明**：TJUClaw 的主要开发仓库公开可访问。全平台自动化构建、跨端编译矩阵（Linux / Windows / Android）以及多项集成测试由持续集成流水线完成。如需检出最新完整源码、追踪流水线状态或提交 Issue / PR，请通过下表仓库地址访问。

| 仓库 / 模块 | 访问级别 | 许可证 | 技术栈 | 职责与说明 | 本地路径 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **[tjuclaw](https://github.com/yunzaixi-dev/tjuclaw)** | 开源 | Apache-2.0（根仓材料） | TypeScript · Next.js 16.3 · Fumadocs | **总集成仓与文档**<br />包含 Taskfile 统一指令、文档站与 Ansible 部署配置 | 根目录 (`.`) |
| **[tjuclaw-client](https://github.com/yunzaixi-dev/tjuclaw-client)** | 开源 | GPL-3.0-only | TypeScript · React 19 · Tauri v2 | **多端客户端**<br />构建 Web 端及 Windows、Linux、Android 客户端 | `frontend/` |
| **[tjuclaw-server](https://github.com/yunzaixi-dev/tjuclaw-server)** | 闭源 | 未授权（保留所有权利） | Go 1.27 | **业务 API 与会话网关**<br />处理业务逻辑、任务状态管理与认证鉴权 | `backend/` |
| **[tjucli](https://github.com/yunzaixi-dev/tjucli)** | 开源 | GPL-3.0-only | Go 1.27 | **命令行工具与 Tool Server**<br />将校园公开服务封装为标准输入输出的 CLI 工具 | `cli/` |
| **[tjuclaw-crawler](https://github.com/yunzaixi-dev/tjuclaw-crawler)** | 闭源 | 未授权（保留所有权利） | TypeScript · Bun · PostgreSQL | **公开情报采集**<br />采集校园公开信息，生成增量事件流与结构化数据 | `crawler/` |
---

## 许可证与源码边界

这是一个按目录和 Git 子模块分别授权的聚合仓，不存在覆盖所有内容的单一许可证：

- 根仓自己的文档、Taskfile、CI、运维与组合工具使用 **Apache-2.0**；完整文本见仓库根目录的 `LICENSE`，适用范围见 `NOTICE`。
- TJUClaw 自有文档、架构图和宣传材料另采用 **CC BY 4.0**；完整文本见 `LICENSE-DOCS`。转载、修改、材料报送和公开展示时请保留 TJUClaw 署名及 [主仓链接](https://github.com/yunzaixi-dev/tjuclaw)。
- 参加同一大赛的组委会可在赛事相关宣传、材料报送和公开展示中直接复制、修改、转载和使用这些 TJUClaw 自有材料，无需额外申请；第三方截图、Logo、商标、字体、依赖和私有组件源码不在此授权内。
- `frontend/`（`tjuclaw-client`）和 `cli/`（`tjucli`）使用 **GPL-3.0-only**；对应子仓库中的 `LICENSE` 是其源码和再发布条件的准据。
- `backend/`（`tjuclaw-server`）和 `crawler/`（`tjuclaw-crawler`）是闭源组件，**未授予公开使用、复制、修改或再分发许可**；其源码仅用于受控集成和部署。
- 根仓的 Apache-2.0 和 CC BY 4.0 不会授权闭源子模块，也不会替代 GPL 子模块自己的许可证；第三方依赖继续遵循各自许可证。
- 各仓库的 GitHub 地址见上方仓库矩阵；子模块是独立作品，不因被聚合到本仓而改变其许可证。

许可证只授予相应目录或子仓库中的版权作品，不授予 TJUClaw、校名、校徽、服务名称或第三方商标的使用权。

## 核心架构设计

系统设计遵循职责隔离与可验证原则，主要体现在以下几个维度：

### 1. 跨平台客户端
基于同一套前端组件与状态逻辑构建 Web 与各桌面/移动平台客户端，保持交互与视觉一致，支持在 PC 端创建任务并在移动端查看进度。

### 2. 存算分离
任务执行环境与数据存储分离。智能体操作在无状态的临时沙箱中运行；业务记录由 PostgreSQL 承接，文件字节走对象存储。

### 3. 沙箱隔离与执行安全
对于涉及文件下载与脚本运行的流程，调度隔离沙箱执行；敏感认证信息统一使用同源 HttpOnly Cookie 管理，凭据不暴露给大模型上下文。

### 4. 记忆与检索
区分当前任务上下文的工作记忆与长期偏好记忆；结合自托管知识检索引擎 WeKnora，实现文档知识的检索与召回。

### 5. 确定性工具接口
将校园公开服务封装为强类型的独立命令行工具 `tjucli`，输出标准 JSON，通过命令执行状态码和文件哈希（SHA-256）验证执行结果。

### 6. 云边协同部署
静态站点部署于 EdgeOne 边缘网络，动态 API 请求通过网关反向代理至后端服务容器，多平台客户端通过自动化流水线完成构建与测试。

---

## 模型组合选择

TJUClaw 不让一个模型承担从文档解析到 Agent 执行的全部工作，而是根据任务边界选择不同模型：

| 任务 | 当前选择 | 作用 |
| :--- | :--- | :--- |
| Agent 主模型 | DeepSeek-V4.1-Flash (`deepseek-v4-flash`) | 由 Pi 驱动规划、工具调用、观察反馈与最终回答 |
| 文档整理 | Qwen3.8-Flash (`qwen3.8-flash`) | 修复损坏结构，整理派生 Markdown 与文档元数据 |
| 向量嵌入 | Qwen3.7 通用文本向量 (`qwen3.7-text-embedding`) | 生成 1024 维 WeKnora 检索向量 |
| 候选重排 | Qwen3.7 通用文本重排序 (`qwen3.7-text-rerank`) | 对向量召回结果进行二阶段排序 |
| OCR 与版面解析 | PaddleOCR | 处理扫描 PDF 和图片中的文字与版面 |


主模型关注 Agent 的行动与交付，文档模型关注内容归一化，Embedding 与 Rerank 关注知识检索；职责分离让每个环节都能独立评测、替换和回滚。详细选择依据见：[数据管道与向量化](./blog/data-pipeline.md) 和 [Pi 与主模型选择](./blog/why-pi-as-agent-harness.md)。

---

## 技术博客 (Engineering Blog)

各子系统在设计、实现与踩坑上的记录：

1. [《数据的复杂采集、脱敏、归一与向量化》](./blog/data-pipeline.md)：以线上学院站与课程网盘的真实体量为上游，说明从公开 HTML/PDF 到 Canonical Markdown、WeKnora、文档溯源与 Agent 检索的目标管道。
2. [《为什么我们选择 Pi 作为 Agent 底座》](./blog/why-pi-as-agent-harness.md)：对比 Chatbox 与 Harness 两种形态，说明为何不采用 LangChain/LangGraph、Pi 在产品执行链里的位置，以及它当前的状态。
3. [《祖传前后端架构，但是 2026》](./blog/backend-architecture.md)：一次浏览器请求要穿过几个域名？拆开 TJUClaw 的真实拓扑——Go 标准库、两级边缘接力、只剥一次的前缀，与一张不认客户端的会话门禁。
4. [《智能体的代码执行、文件系统，与隔离沙箱》](./blog/code-execution-and-sandbox.md)：代码执行的生命周期、工作区文件系统与腾讯云沙箱的隔离边界，以及 `tjucli-server` 的单次授权代理。
5. [《为什么我们把 Agent 的能力做成 CLI：tjucli 的设计》](./blog/why-cli-as-agent-tool.md)：对比 MCP、SDK 与独立二进制三条路，说明确定性 JSON 封套、双模运行与原子落盘的取舍。
6. [《跨平台智能体客户端的实现：Web、桌面端与移动端》](./blog/cross-platform-clients.md)：单一代码仓库驱动 Web、Linux、Windows 与 Android；Tauri v2 宿主、OKLCH 语义令牌与同源会话流。
7. [《从代码仓库到持续交付：TJUClaw 的仓库划分与 CI/CD》](./blog/repository-and-cicd.md)：Git 子模块拓扑、两分支模型、跨平台构建矩阵与两步发版，以及三个 EdgeOne Makers 项目的静态部署。
