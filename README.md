# TJUClaw

**面向天津大学学生的校园行动智能体。**

TJUClaw 的目标是不止回答校园问题，还能结合校园信息与用户提供的资料，
帮助完成任务并交付可查看的结果。

本仓库用于产品开发，文档站是其中的辅助组件，不是产品本身。
当前已实现 Web 邮箱验证码认证与 UI 基础；校园服务和 Agent 任务执行尚未接入。
生产认证服务仍需配置并单独验收，不能把本地联调等同于上线。

## 当前状态

| 组件 | 状态 |
| --- | --- |
| 产品客户端 | React + Vite，共用界面；Tauri 原生端初始化 |
| 构建目标 | Web、Android、Linux、Windows；不配置 Apple 平台 |
| 产品后端 | Go HTTP 服务，健康检查、Kratos 流程边界与真实会话校验 |
| 文档站 | 独立 Next.js + Fumadocs 应用 |
| 本地容器 | Web + API Compose 开发栈，不是生产部署 |
| CI | GitHub 托管 Actions 运行完整检查与各平台构建；GitLab 保留比赛源码 |

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
竞赛演示稿先运行 `rtk task slides:install`，再用 `rtk task slides:dev` 在
`http://127.0.0.1:3030` 预览；构建和 PDF 导出见
[Slidev 说明](presentation/README.md)。
`task dev` 不启动外部认证或任务执行基础设施。

校园 CLI 使用 `rtk task cli:build` 构建，输出到 `backend/bin/tjucli`；
`rtk task cli:test` 运行针对性测试。目前支持公开课程目录、课程名检索和
选定文件下载，命令及覆盖缺口见 [tjucli 说明](backend/TJUCLI.md)。

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

GitHub Actions 在托管 Ubuntu / Windows Runner 上执行检查、真实认证回归及
Web、文档、API、CLI、Linux、Android、Windows 构建。GitLab 旧 Runner 作业已停用。
CI 配置和同步方式见 [CI 手册](ops/ci/README.md)；以实际运行链接和提交 SHA
判断远端验收是否通过。公开仓库的日志与构建制品可公开访问，因此不上传私有
审计资料或完整测试输出目录。流水线不自动发布正式版本或部署。

本地视觉审计使用 `rtk task audit:dev`，数据准备与验证见开发手册。
审计素材只保存在被 Git 排除的本地目录，不进入正常客户端构建。

产品入口为邮箱登录与注册；外观演示保留在 `/preview/appearance`。UI 组件与主题约定见
[UI 基础规范](frontend/UI.md)；首次执行 `rtk task ui:install` 安装测试浏览器，
之后用 `rtk task ui:test` 验证主题与四种响应式尺寸。

邮箱认证开发先运行 `rtk task auth:up`，再分别启动 `rtk task auth:dev` 和
`rtk task web:dev`。本地邮件查看地址为 `http://127.0.0.1:18025`，
真实 Kratos 回归使用 `rtk task auth:test`，不向真实邮箱发送邮件。
接入说明见 [邮箱认证](ops/auth/README.md)，协作基准见
[前后端开发基准](DEVELOPMENT.md)。原生端认证尚需独立适配。

## 访问与保密

GitLab 比赛项目保持 **Private**；GitHub 源码在 `yunzaixi-dev` 下公开。
内部计划、研究原件、设计参考素材、实际部署配置和凭据不提交或同步。

部署前应审核 `docs/content/docs/`、`docs/public/`、客户端资源和构建产物，
不能把 `.gitignore` 当成站点访问控制。

本项目未授予开源许可；第三方依赖仍按各自许可使用。
