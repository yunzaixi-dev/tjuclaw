---
title: 介绍 TJUClaw
description: 平台定位、多端接入方式、仓库矩阵、核心架构与技术博客专栏。
---

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

> **主要仓库说明**：TJUClaw 的主要开发仓库托管于 GitHub。由于全平台自动化构建、跨端编译矩阵（Linux / Windows / Android）以及多项前沿集成测试强依赖 GitHub Actions 提供的 CI/CD 算力支持，如需检出最新完整源码、追踪流水线状态或提交 Issue / PR，请直接访问 GitHub 对应仓库。

| 仓库 / 模块 | 访问级别 | GitHub 仓库地址 | 技术栈 | 职责与说明 | 本地路径 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **tjuclaw** | 开源 | [yunzaixi-dev/tjuclaw](https://github.com/yunzaixi-dev/tjuclaw) | TypeScript · Next.js 16.3 · Fumadocs | **总集成仓与文档**<br />包含 Taskfile 统一指令、文档站与 Ansible 部署配置 | 根目录 (`.`) |
| **tjuclaw-client** | 开源 | [yunzaixi-dev/tjuclaw-client](https://github.com/yunzaixi-dev/tjuclaw-client) | TypeScript · React 19 · Tauri v2 | **多端客户端**<br />构建 Web 端及 Windows、Linux、Android 客户端 | `frontend/` |
| **tjuclaw-server** | 开源 | [yunzaixi-dev/tjuclaw-server](https://github.com/yunzaixi-dev/tjuclaw-server) | Go 1.27 | **业务 API 与会话网关**<br />处理业务逻辑、任务状态管理与认证鉴权 | `backend/` |
| **tjucli** | 开源 | [yunzaixi-dev/tjucli](https://github.com/yunzaixi-dev/tjucli) | Go 1.27 | **命令行工具与 Tool Server**<br />将校园公开服务封装为标准输入输出的 CLI 工具 | `cli/` |
| **tjuclaw-crawler** | 闭源 | [yunzaixi-dev/tjuclaw-crawler](https://github.com/yunzaixi-dev/tjuclaw-crawler) | TypeScript · Bun · PostgreSQL | **公开情报采集**<br />采集校园公开信息，生成增量事件流与结构化数据 | `crawler/` |
---

## 核心架构设计

系统设计遵循职责隔离与可验证原则，主要体现在以下几个维度：

### 1. 跨平台客户端
基于同一套前端组件与状态逻辑构建 Web 与各桌面/移动平台客户端，保持交互与视觉一致，支持在 PC 端创建任务并在移动端查看进度。

### 2. 存算分离
任务执行环境与数据存储分离。智能体操作在无状态的临时沙箱中运行，任务元数据、文件与长期记忆由独立的存储系统（PostgreSQL、对象存储 COS 等）承接。

### 3. 沙箱隔离与执行安全
对于涉及文件下载与脚本运行的流程，调度隔离沙箱执行；敏感认证信息统一使用同源 HttpOnly Cookie 管理，凭据不暴露给大模型上下文。

### 4. 记忆与检索
区分当前任务上下文的工作记忆与长期偏好记忆；结合自托管知识检索引擎 WeKnora，实现文档知识的检索与召回。

### 5. 确定性工具接口
将校园公开服务封装为强类型的独立命令行工具 `tjucli`，输出标准 JSON，通过命令执行状态码和文件哈希（SHA-256）验证执行结果。

### 6. 云边协同部署
静态站点部署于 EdgeOne 边缘网络，动态 API 请求通过网关反向代理至后端服务容器，多平台客户端通过自动化流水线完成构建与测试。

---

## 技术博客与深度专题 (Engineering Blog)

TJUClaw 涵盖了客户端跨端、网关会话、沙箱调度、知识检索与数据抓取等多项技术栈。为了探讨系统演进与核心工程细节，我们开启了技术博客专栏：

1. [《数据的复杂采集、脱敏、归一与向量化》](/docs/blog/data-pipeline)：从杂乱现实世界的 HTML、PDF、Word 到统一规范的 Markdown 与向量空间，深度解析数据管道中的技术攻坚细节。
2. [《为什么我们选择 Pi 作为 Agent 底座》](/docs/blog/why-pi-as-agent-harness)：从 Chatbox 与 Harness 的范式之辨出发，探讨我们为何放弃 LangChain/LangGraph 而选择轻量图灵完备的 Pi 作为核心执行环境。
3. [《从零构建云端智能体平台：后端、沙箱与运行时》](/docs/blog/agent-platform)：深入解析 TJUClaw 在 Go 业务 API 网关、腾讯云微隔离执行沙箱与 Agent 运行时架构中的核心设计与工程落地。
