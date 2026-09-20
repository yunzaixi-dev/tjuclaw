# GitHub CI、GitLab 镜像与比赛 Release

GitHub 是唯一开发主平台。GitLab 比赛项目接收单向源码镜像、外部 CI 状态和
客户端安装包；不再运行旧 Kubernetes/Compose Runner 作业。

## 自动部署与 Actions 白名单

`release` 发布的运行配置、回滚方式及验证范围见 [Ansible 部署说明](../ansible/DEPLOY.md)。
仓库 Actions 白名单须包含所有使用的固定动作 SHA。新增的部署动作是
`actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`，集成运维检查还使用
`astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d`。
Bun 1.3.14 安装使用 `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`，同样须加入白名单。
本地 actionlint 不会检查 GitHub 服务端白名单；遗漏时即使部署任务在 dev 上跳过，整个工作流也会启动失败。

## 仓库职责

| 仓库 | 可见性 | 职责 |
| --- | --- | --- |
| `yunzaixi-dev/tjuclaw` | Private | 集成版本、精确组件指针、文档、真实认证/任务归属回归、GitLab 同步和 Release |
| `yunzaixi-dev/tjuclaw-client` | Public | React/Tauri、UI/工作区回归、Web/Linux/Windows/Android 构建 |
| `yunzaixi-dev/tjuclaw-server` | Private | Go API、静态检查、race tests 和 API 构建 |
| `yunzaixi-dev/tjucli` | Private（暂定） | 校园 CLI、Skill、独立检查与构建 |
| `yunzaixi-dev/tjuclaw-crawler` | Private | Bun RSS、PostgreSQL 更新回放、独立检查；集成锁定 `crawler/` SHA |

客户端和集成仓库分别使用自己的 pnpm workspace/lockfile，服务端与 CLI 使用独立
Go module；crawler 使用独立 Bun 依赖和 `bun.lock`。公开客户端保留 GitHub 托管
Ubuntu/Windows；四个私有仓库使用 `prod-sg` ARC 的仓库级临时 Runner。根仓和 crawler
使用隔离 DinD 池，服务端与 CLI 使用非特权池，空闲时缩容到零。

## 开发与组合检查

1. 在组件仓库实现并提交修改，通过该仓库 CI 后推送可访问的提交。
2. 在集成仓库更新 `frontend/`、`backend/`、`cli/` 或 `crawler/` 的 submodule SHA，并逐路径暂存。
3. 运行 `task check` 和需要的组合回归。真实认证使用 `task auth:test`，不使用 mock 替代。
4. 合并或直接在 GitHub release 迭代（集成与生产部署基于 release，dev 保留备用）。集成 CI 检查锁定的组件组合，单向推送同 SHA 到 GitLab release。

客户端负责外观与工作区回归及原生打包。仅修改服务端不会重新构建四个平台客户端。
集成仍会构建 Web 以验证实际认证/任务接口；这是组合回归的一部分。

## 源码与状态同步

- 旧 GitLab → GitHub Push Mirror 已停用，禁止与新方向同时启用。
- `CI` 的 `mirror` job 只推送 release 或明确的版本标签，不使用 force、删除引用或全量 mirror。
- `.gitlab-ci.yml` 停用原 Runner 作业。可信的 `GitLab Commit Status` 工作流在 CI 完成后
  回写 `github-actions/ci`，保留 GitHub 运行链接。
- 状态回写只处理本仓库 release 的 push；脚本检查准确提交、最新运行与受限 API 域名。
  未保护的其他分支和 GitLab MR 合并结果不自动获得镜像主线的验收保证。
- GitLab release 保持与 GitHub 集成提交相同的 SHA。它包含 submodule 指针；完整源码另随
  Release 提供，不能把 GitLab 自动生成的源码 ZIP 当成已包含私有组件。

首次 `v0.0.25` 的 GitLab 标签为轻量标签：checkout v4 的默认回退抓取丢失了附注，
但指向的源码提交与 GitHub 完全一致。后续标签显式检出 tag ref，保留附注对象；
已发布 `v0.0.25` 的引用和文件内容保持原样。

## 两步发布安装包

在相关组件和集成 CI 全部通过后，由维护者明确选择版本发布。

```bash
# 1. 在客户端 release 上执行，指定集成仓库锁定的 frontend SHA。
gh workflow run packages.yml --repo yunzaixi-dev/tjuclaw-client --ref release \
  -f source_sha=<40位客户端SHA>

# 2. 第一步成功后，在集成 release 上发布当前集成版本。
gh workflow run release.yml --repo yunzaixi-dev/tjuclaw --ref release \
  -f version=<当前集成版本>
```

第一步读取指定 SHA 最新且成功的 `CI` 与 `Windows Installer` 运行，校验 GitHub
artifact ZIP 的 SHA-256，仅提取各一个 `.deb`、`.exe`、`.apk`，上传到 GitLab
Generic Package Registry 的 `tjuclaw-client/<client SHA>/`。`manifest.json` 最后上传，
作为该批产物上传完整的标记。

第二步核对集成 CI、组件 gitlink、客户端清单和下载摘要。它仅从 Git 跟踪的准确提交
生成包含所有组件的源码快照，再把安装包、源码快照、`SHA256SUMS.txt` 发布到 GitLab
版本包与 Release。文件实际存于 GitLab，Release 资产提供稳定下载入口。

- 同一版本同一文件内容可重试；摘要冲突、标签指向变化和资产链接冲突必须失败。
- 评审下载 `TJUClaw-source-<version>.tar.gz` 可取得全部组件，包含 `SOURCE.json` 溯源信息。
  源码归档不带 `.git` 或私有运行状态；可分别安装根目录与 `frontend/` 的锁定依赖后构建。
- Windows 包未签名，Android 为 arm64 调试 APK。开发 Release 不代表签名、部署或真机验收。
- 此流程不自动创建 GitHub Release、Pages、容器发布或生产部署。

## 凭据边界

| 所在仓库 | Secret | 权限与用途 |
| --- | --- | --- |
| 私有集成 | `SERVER_READ_KEY`、`CLI_READ_KEY`、`CRAWLER_READ_KEY` | 分别只能读取一个私有组件 |
| 私有集成 | `GITLAB_SYNC_TOKEN` | 仅比赛项目的源码推送权限 |
| 私有集成 | `GITLAB_STATUS_TOKEN` | 仅比赛项目的外部 CI 状态回写 |
| 私有集成 | `GITLAB_RELEASE_TOKEN` | 仅比赛项目的包与 Release API |
| 公开客户端 | `GITLAB_PACKAGE_TOKEN` | 部署令牌，仅 read/write_package_registry，无源码读取权限 |
| `prod-sg` `arc-runners` | `arc-github-token` | 仅 ARC 控制器读取，用于四个私仓的仓库级临时 Runner 注册；Runner Pod 不挂载 Kubernetes 服务账号令牌 |

API 令牌使用项目级账号，不向 Actions 分发个人 GitLab PAT。受保护 release 的推送/状态
操作需要相应项目角色。令牌和组件密钥保存在 Actions Secrets；本地备份只能在忽略目录。
公开构建日志不得包含私有研究、审计截图、完整测试输出或临时签名下载 URL。

## 比赛统计与可见性

[比赛官网 FAQ](https://agent2026.tju.edu.cn/ai-competition/introduction/docs/faq.html)
明确：私有项目影响 Star、下载量等记分，Internal 可向校内已登录用户开放。
目前比赛项目仍为 Private，扩大可见性需要维护者明确决定；项目历史包含服务端源码。

官网尚未给出本流程所用 Release/Generic Package 下载的具体计数口径。上传成功和
鉴权下载成功只证明交付链路成立，不证明比赛计分已增长。完整源码快照是交付选择，
不能把其他参赛项目的提交清单当成官方禁止 submodule 的规则。
