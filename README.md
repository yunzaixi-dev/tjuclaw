# TJUClaw Engineering Wiki

私有开发仓库。基于 Next.js 与 Fumadocs 的项目文档站与产品目录分开维护。
本项目未授予开源许可；第三方依赖仍按各自许可使用。

## Repository Layout

| 目录 | 用途 |
| --- | --- |
| `src/`、`content/docs/` | 现有 Wiki 应用和可公开文档，暂留根目录 |
| `frontend/` | 产品前端，与 Wiki 分开 |
| `backend/` | 产品后端 |
| `ops/` | 部署、运维配置与操作手册 |
| `scripts/`、`.githooks/` | 仓库检查与 Git hooks |

新增组件先实现最小可运行入口，再按实际职责拆分。当前前后端与运维目录只定义边界，不代表服务已实现。
协作、提交格式与版本号见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Development

```bash
pnpm install
pnpm git:setup
pnpm dev
```

打开 `http://localhost:3000`。

## Commands

```bash
pnpm lint
pnpm run types:check
pnpm build
pnpm test:git
```

研究资料与凭据不得提交或进入公开站点。首次部署前应审核 `content/docs/` 和
`public/` 的实际内容，不能把 `.gitignore` 当成站点访问控制。

GitLab 项目必须使用 **Private** 可见性，不得改成 Internal 或 Public。
私有仓库也不收录内部计划、研究原件、实际部署配置和凭据。
