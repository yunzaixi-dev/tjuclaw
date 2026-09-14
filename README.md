# TJUClaw

**面向天津大学学生的校园行动智能体。**

TJUClaw 的目标是不止回答校园问题，还能结合校园信息与用户提供的资料，
帮助完成任务并交付可查看的结果。

本仓库是私有产品集成仓库；GitHub 为开发主平台，GitLab 为比赛镜像与下载渠道。
文档站同时承载官网首页与客户端下载，产品应用保持独立部署。

- 官网、文档与下载：<https://tjuclaw.cloud>
- Web 应用：<https://app.tjuclaw.cloud>
- 兼容的旧文档地址：<https://wiki.tjuclaw.cloud>

浏览器认证和 API 请求使用应用同源的 `https://app.tjuclaw.cloud/api/*`。
当前已实现 Web 邮箱验证码认证、任务草稿保存与公开课程资料 CLI；Agent 任务执行尚未接入。
生产认证服务仍需配置并单独验收，不能把本地联调等同于上线。

## 当前状态

| 组件 | 状态 |
| --- | --- |
| 产品客户端 | React + Vite，共用界面；Tauri 原生端初始化 |
| 构建目标 | Web、Android、Linux、Windows；不配置 Apple 平台 |
| 产品后端 | Go HTTP 服务，ZITADEL 邮箱认证与会话边界（迁移验收中） |
| 文档站 | 独立 Next.js + Fumadocs 应用 |
| 本地容器 | Web + API Compose 开发栈，不是生产部署 |
| CI | GitHub 托管 Actions 运行完整检查与各平台构建；GitLab 保留比赛源码 |

## 仓库结构

| 目录 | 用途 |
| --- | --- |
| `frontend/src/` | Web 与原生客户端共用 React 界面 |
| `frontend/src-tauri/` | Tauri 原生宿主、权限与打包配置 |
| `backend/cmd/api/` | 私有服务端子仓库：Go API 入口及测试 |
| `cli/` | 校园 CLI、内部工具 HTTP 服务与 `skills/tjucli/` |
| `crawler/` | 私有 Bun RSS 与持久更新回放子仓库，当前使用合成来源 |
| `docs/` | 文档站源码与经审核的站点内容 |
| `ops/images/`、`ops/runbooks/` | 容器定义与开发 / CI 操作说明 |
| `scripts/`、`.githooks/` | 仓库检查与 Git hooks |
| `Taskfile.yml` | 开发命令统一入口 |
| `compose.yaml`、`.gitlab-ci.yml` | 本地容器与跨平台构建编排 |

`frontend/`、`backend/`、`cli/`、`crawler/` 分别锁定独立仓库的提交；组件版本与依赖各自管理。
客户端源码位于 [tjuclaw-client](https://github.com/yunzaixi-dev/tjuclaw-client)。
服务端、CLI 与 [tjuclaw-crawler](https://github.com/yunzaixi-dev/tjuclaw-crawler) 当前为私有仓库，需要相应访问权限。

```bash
rtk git clone --recurse-submodules https://github.com/yunzaixi-dev/tjuclaw.git
# 已有克隆在更新集成提交后：
rtk git submodule update --init --recursive
```

先提交、推送并验证组件，再更新本仓库的 submodule 指针。不要把忽略的本地资料复制到子仓库。

## 开始开发

安装 Node、pnpm、Bun 1.3.14、Task、Go；原生开发还需要 Rust 和平台 SDK。
具体版本与平台依赖见 [开发与 CI 手册](ops/runbooks/development.md)。
在仓库根目录运行，以下示例使用 RTK：

```bash
rtk task setup
rtk task doctor
rtk task dev
```

产品 Web：`http://127.0.0.1:1420`；开发 API：`http://127.0.0.1:18088/healthz`。
文档站单独使用 `rtk task docs:dev`，地址 `http://127.0.0.1:3030`。
`task dev` 需要 Docker，自动启动独立的 Kratos、PostgreSQL、Cap、Valkey；开发默认使用与云端相同的真实 SMTP（`ops/auth/.env.local`），一次性 `auth:test` 才用隔离收件箱。不启动任务执行基础设施。
重复运行时会先释放本 checkout 的旧 Web/API 进程占用的 1420、18088 端口，再启动新进程；其他项目的进程和 8080 端口保持不动。单独运行 `task web:dev`、`task auth:dev` 也会执行对应清理。

校园工具使用 `rtk task cli:build` 构建，输出 `cli/bin/tjucli` 和
`cli/bin/tjucli-server`；`rtk task cli:test` 覆盖全部CLI与服务端包。
目前支持公开课程目录、课程名检索和选定文件下载，命令及覆盖缺口见
[tjucli 说明](cli/TJUCLI.md)。配置受限授权文件后可用 `rtk task cli:server:dev`
启动本地工具服务，协议与凭据边界见 [工具服务说明](cli/TOOL_SERVER.md)。
这一服务不代表产品 Pi 或云沙箱执行已经接通。

RSS 子模块使用 `rtk task crawler:setup` 安装锁定依赖，`rtk task crawler:import`
显式导入合成示例，`rtk task crawler:dev` 在本机 3031 端口启动服务。
`rtk task crawler:check` 和 `rtk task crawler:test` 已纳入 `task check`；
订阅与回放协议见 [crawler README](crawler/README.md)。默认 `task dev` 不启动该服务。

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
根 `package.json` 管理集成版本；Tauri 读取 `frontend/package.json`，CLI 读取自己的版本元数据。
集成版本通过 submodule SHA 确定组件组合；版本号不表示功能已完成。
Linux 和 Windows 构建分别在对应系统运行。Android 默认生成 arm64 调试 APK，
Windows 默认生成未签名安装程序；它们不是正式发布包。

GitHub Actions 在各组件仓库执行独立检查与构建；客户端负责各平台安装包，
本仓库保留真实认证、任务归属及组合检查。服务端修改不会触发客户端原生打包。
GitHub release 和版本标签单向同步到 GitLab；GitLab 旧 Runner 作业已停用。
CI 配置和同步方式见 [CI 手册](ops/ci/README.md)；以实际运行链接和提交 SHA
判断远端验收是否通过。公开仓库的日志与构建制品可公开访问，因此不上传私有
审计资料或完整测试输出目录。安装包通过独立手动流程上传 GitLab，并与完整源码快照、SHA-256 一起挂到 Release。
这不包含部署、签名或真机验收，发布步骤见 CI 手册。

本地视觉审计使用 `rtk task audit:dev`，数据准备与验证见开发手册。
审计素材只保存在被 Git 排除的本地目录，不进入正常客户端构建。

产品入口为邮箱登录与注册；外观演示保留在 `/preview/appearance`。UI 组件与主题约定见
[UI 基础规范](frontend/UI.md)；首次执行 `rtk task ui:install` 安装测试浏览器，
之后用 `rtk task ui:test` 验证主题与四种响应式尺寸。

邮箱认证开发使用 `rtk task dev`，也可分别运行 `rtk task auth:dev` 和
`rtk task web:dev`。开发默认走与云端相同的真实 SMTP；本地 Mailpit
（`http://127.0.0.1:18027`）只在 `AUTH_DEV_MAIL_MODE=captured` 时启用。
一次性 Kratos/Cap 回归使用 `rtk task auth:test`，不向真实邮箱发送邮件。
`rtk task auth:down` 保留本地身份和密钥；运行中的开发链路可用
`node scripts/auth-dev-smoke.mjs` 验证。
接入说明见 [邮箱认证](ops/auth/README.md)，协作基准见
[前后端开发基准](DEVELOPMENT.md)。原生端认证尚需独立适配。

## 访问与保密

GitHub 集成仓库、服务端与 CLI 当前为 **Private**，客户端单独公开。
GitLab 比赛项目目前仍为 **Private**；官网 FAQ 明确私有可见性影响下载等计分，
最终是否向校内用户开放需要维护者决定，不能把上传成功当成统计已接通。
内部计划、研究原件、设计参考素材、实际部署配置和凭据不提交或同步。

部署前应审核 `docs/content/docs/`、`docs/public/`、客户端资源和构建产物，
不能把 `.gitignore` 当成站点访问控制。

本项目未授予开源许可；第三方依赖仍按各自许可使用。
