---
title: 开发环境与本地验证
description: 开发者工具链、依赖安装、核心服务启动与本地验证命令。
---

# 开发环境与本地验证

本文档指导开发者在本地搭建并运行 TJUClaw 的开发与文档环境。普通用户请阅读[产品使用指南](/docs/guide)。

---

## 环境依赖

在开始之前，请确保本地已安装以下工具链：

- **Node.js**: `>= 22.12.0`（推荐使用 Node 26 LTS）
- **pnpm**: `>= 11.0.0`
- **Go**: `>= 1.27.0`
- **Bun**（情报采集服务开发需要）: `>= 1.3.0`
- **Taskfile (go-task)**: `>= 3.35.0`
- **Rust / Cargo**（编译桌面客户端时需要）: `>= 1.90.0`（Tauri v2）

---

## 依赖安装

克隆仓库后，在根目录执行依赖安装：

```bash
# 安装所有子模块依赖与开发环境设置（冻结 pnpm 锁文件、Bun 采集器依赖及 git hooks）
task setup

# 运行开发环境健康诊断
task doctor
```

---

## 启动本地服务

TJUClaw 采用 Taskfile 统一调度多端与服务的启动：

### 1. 启动文档站（Wiki）

```bash
task docs:dev
```

启动后可在浏览器访问文档首页：`http://localhost:3000`。

### 2. 启动前端 Web 客户端与 API 服务

```bash
task dev
```

前端开发服务器将运行在 `http://127.0.0.1:5173`，并通过同源代理 `/api/*` 连接 Kratos + Cap + Go API 组合服务（端口 `:8080`）。

### 3. 本地启动独立知识引擎 (WeKnora)

```bash
# 启动环回隔离的 WeKnora 知识栈（UI :18180，API :18181）
task weknora:up

# 停止并保留本地卷数据
task weknora:down
```

### 4. 启动校园公开情报流与采集 (Crawler)

```bash
# 启动情报 Feed 服务（端口 :3031）
task crawler:dev

# 运行真实校园数据源单次抓取
task crawler:crawl
```
---

## 常用质量检查命令

在提交代码前，请执行以下检查任务以确保符合 CI 规范：

```bash
# 全局快速语法与格式检查
task check

# 文档静态生成构建验证
task docs:build

# 运行全局质量门禁检查（lint、类型检查、单元测试与 git 策略）
task check

# 运行端到端认证闭环测试（含真实 Kratos + Cap + 抓取邮件）
task auth:test

# 运行 WeKnora 知识栈冒烟测试
task ops:test

# 编译核心目标产物（Web、Docs、API、CLI）
task build
```
