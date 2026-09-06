# TJUClaw

**面向天津大学学生的校园行动智能体。**

TJUClaw 的目标是不止回答校园问题，还能结合校园信息与用户提供的资料，
帮助完成任务并交付可查看的结果。

本仓库用于产品开发，文档站是其中的辅助组件，不是产品本身。
当前为跨平台工程初始化版本，校园服务、登录和 Agent 任务执行尚未接入。

## 当前状态

| 组件 | 状态 |
| --- | --- |
| 产品客户端 | React + Vite，共用界面；Tauri 原生端初始化 |
| 构建目标 | Web、Android、Linux、Windows；不配置 Apple 平台 |
| 产品后端 | Go HTTP 服务，仅实现健康检查 |
| 文档站 | 独立 Next.js + Fumadocs 应用 |
| 本地容器 | Web + API Compose 开发栈，不是生产部署 |
| CI | 校园 GitLab 已启用；推送构建配置并接入 Runner 后执行 |

## 仓库结构

| 目录 | 用途 |
| --- | --- |
| `frontend/src/` | Web 与原生客户端共用 React 界面 |
| `frontend/src-tauri/` | Tauri 原生宿主、权限与打包配置 |
| `backend/cmd/api/` | Go API 入口及测试 |
| `docs/` | 文档站源码与经审核的站点内容 |
| `ops/images/`、`ops/runbooks/` | 容器定义与开发 / CI 操作说明 |
| `scripts/`、`.githooks/` | 仓库检查与 Git hooks |
| `Taskfile.yml` | 开发命令统一入口 |
| `compose.yaml`、`.gitlab-ci.yml` | 本地容器与跨平台构建编排 |

使用单仓库和 pnpm workspace，组件可以独立构建，不引入 Git submodule。

## 开始开发

安装 Node、pnpm、Task、Go；原生开发还需要 Rust 和平台 SDK。
具体版本与平台依赖见 [开发与 CI 手册](ops/runbooks/development.md)。
在仓库根目录运行，以下示例使用 RTK：

```bash
rtk task setup
rtk task doctor
rtk task dev
```

产品 Web：`http://127.0.0.1:1420`；API：`http://127.0.0.1:8080/healthz`。
文档站单独使用 `rtk task docs:dev`，地址 `http://127.0.0.1:3000`。
`task dev` 不启动外部认证或任务执行基础设施。

## 检查与构建

```bash
rtk task --list
rtk task check
rtk task build
rtk task linux:build
rtk task windows:build
rtk task android:build
rtk task compose:up
rtk task compose:smoke
rtk task compose:down
```

协作方式、提交格式与版本规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。
根 `package.json` 是产品版本的唯一来源，Tauri 直接读取它；版本号不表示产品已发布。
Linux 和 Windows 构建分别在对应系统运行。Android 默认生成 arm64 调试 APK，
Windows 默认生成未签名安装程序；它们不是正式发布包。

CI 配置了检查及各客户端自动构建，但当前项目尚无 Runner，
因此不能把配置完成理解为云端已成功产出安装包。制品仅 Maintainer 可下载，
七天后过期，不自动发布或部署。

本地视觉审计使用 `rtk task audit:dev`，数据准备与验证见开发手册。
审计素材只保存在被 Git 排除的本地目录，不进入正常客户端构建。

## 访问与保密

GitLab 项目必须使用 **Private** 可见性，不得改成 Internal 或 Public。
即使仓库私有，内部计划、研究原件、设计参考素材、实际部署配置和凭据也不提交。

部署前应审核 `docs/content/docs/`、`docs/public/`、客户端资源和构建产物，
不能把 `.gitignore` 当成站点访问控制。

本项目未授予开源许可；第三方依赖仍按各自许可使用。
