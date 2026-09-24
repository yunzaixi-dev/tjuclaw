---
title: 密钥与凭据管理
description: TJUClaw 的秘密值、普通配置和注入边界
---

# 密钥与凭据管理

TJUClaw 的密钥不应该被当成一份越来越长的 `.env`。不同组件需要的秘密值，
生命周期、权限范围和轮换方式并不相同。这里的原则是：

> 秘密值只在真正消费它的进程中出现；普通配置可以被复用，秘密值不能靠复用来
> 省事。

本文是跨前端、API、沙箱、爬虫、WeKnora、NewAPI、Ansible 和 CI 的密钥总账。
示例文件只描述变量名和格式，绝不放真实值。

## 三类配置

| 类别 | 例子 | 存放方式 | 是否能进入浏览器 |
| --- | --- | --- | --- |
| 普通配置 | URL、端口、模型名、超时、bucket 名 | 版本库中的 example、部署变量 | 只有明确标记为公开的配置才能进入 |
| 服务秘密 | API Key、数据库密码、SMTP 密码、签名密钥 | GitHub Secret、Ansible Vault、目标机 `0600` 文件或 Kubernetes Secret | 不能 |
| 用户秘密 | 用户模型 Key、Forgejo 授权、远程主机凭据、临时解密密钥 | 服务端密钥槽或一次性运行时通道 | 不能持久化到条目、日志、Run 或模型上下文 |

`DATABASE_URL`、SMTP URI 和带凭据的连接串即使看起来像普通 URL，也属于服务
秘密。endpoint、bucket、模型名和端口本身通常不是秘密，但不能和对应的密码
拼在同一个 URL 里提交到日志或错误信息。

## 按持有者划分

### 1. Web 客户端

Web、Tauri 和 Docs 只能持有公开配置：

- API 的同源路径；
- 静态站点地址；
- 已明确允许公开的项目标识和功能开关。

客户端不得持有：

- 任意模型提供商 API Key；
- R2、S3、COS 或 Forgejo 凭据；
- Kratos、Cap、NewAPI、WeKnora 或数据库凭据；
- GitHub、GitLab、EdgeOne 的发布凭据；
- 用户工作环境的密码、私钥和临时解密密钥。

`VITE_*`、`import.meta.env` 和静态构建变量都按公开数据处理。只要进入客户端
构建产物，就不能再被当作秘密。

### 2. Go API

Go API 是产品服务的秘密持有者，但只持有它直接需要的值：

| 变量 | 用途 | 注入位置 | 轮换影响 |
| --- | --- | --- | --- |
| `AUTH_COOKIE_KEY` | HttpOnly 会话 Cookie 加密/签名 | API 运行时秘密文件 | 会使现有会话失效，必须保留旧值直到安排会话迁移 |
| `CAP_SITE_KEY` | Cap 站点标识 | API 运行时秘密文件 | 可按站点密钥轮换 |
| `CAP_SECRET_KEY` | Cap 服务端校验 | API 运行时秘密文件 | 与 Cap 站点配置配对轮换 |
| `NEWAPI_API_KEY` | 产品默认模型网关调用（非沙箱会话回退路径） | API 运行时秘密文件 | 只影响模型调用，不应影响用户登录 |
| `WPY_APP_TICKET` | 校园接口应用票据 | API 运行时秘密文件 | 只在校园能力启用时提供 |
| `SANDBOX_GATEWAY_HMAC_SECRET` | API 为每个沙箱会话签发短期访问令牌 | API 运行时秘密文件，并与 gateway 共享 | 轮换会使旧的沙箱令牌失效 |
| `SANDBOX_SESSION_TOKEN` | 兼容旧版 controller 直连协议 | API 运行时秘密文件 | 仅在未启用 HMAC 时使用 |
| `R2_ACCESS_KEY_ID` | 文件对象存储访问标识 | API 运行时秘密文件 | 必须是最小权限、专用 bucket 账号 |
| `R2_SECRET_ACCESS_KEY` | 文件对象存储访问密钥 | API 运行时秘密文件 | 与 R2 access key 成对轮换 |

下面这些是 API 的普通配置，不应当伪装成秘密：

- `APP_PUBLIC_URL`
- `KRATOS_PUBLIC_URL`
- `CAP_URL`
- `NEWAPI_BASE_URL`
- `SANDBOX_SESSION_URL`
- `R2_ENDPOINT`
- `R2_REGION`
- `R2_FILES_BUCKET`
- `NEWAPI_MODEL`
- `NEWAPI_DAILY_QUOTA`

`AUTH_COOKIE_KEY`、模型 Key、对象存储 Key 和沙箱服务令牌不能写入 PostgreSQL
业务记录、笔记正文、发布快照、对象 key、Run JSON 或日志。

### 3. 沙箱 Gateway 与控制器

沙箱控制器的秘密只服务于一次受控运行，不应成为用户代码的环境变量：

| 变量或 Secret 字段 | 用途 | 可见对象 |
| --- | --- | --- |
| `SANDBOX_SESSION_TOKEN` | controller 接受 gateway 转发的 session.v1 请求 | gateway 与 runtime namespace 的同名 Secret |
| `SANDBOX_GATEWAY_HMAC_SECRET` | 校验 API/gateway 签发的短期会话令牌 | gateway 与 API |
| `FORGEJO_TOKEN` | 解析工作区、Git checkout、checkpoint commit 和 push | 仅 gateway Broker |
| `NEWAPI_API_KEY` | 访问产品模型上游并执行配额计数 | 仅 gateway Broker |
| `FORGEJO_BASE_URL`、`NEWAPI_BASE_URL` | provider endpoint 普通配置 | gateway Broker |
| `FORGEJO_WORKSPACE_REPOSITORY` | 工作区仓库普通配置 | gateway Broker 与受限 runtime 配置 |

`FORGEJO_TOKEN` 和 `NEWAPI_API_KEY` 不得进入 controller/Pi 进程、命令行参数、
沙箱用户的普通环境、Run 事件或模型上下文。controller 只得到绑定
`owner/session/entry/profile` 的短期 Broker capability；模型调用和 Forgejo
访问均由 gateway Broker 完成，Broker 同时按用户在 Redis 中原子计数和限制
模型请求。runtime namespace 的 Secret 只能包含 `sandbox-session-token`，
不能复制 provider key。

未来的代码工作区加密还需要独立的密钥经纪模块。其职责不是把主密钥下发给
沙箱，而是根据用户、仓库、commit、profile、run 和过期时间签发一次性会话密钥。
该密钥只能通过 Unix socket、memfd 或权限严格的临时文件进入沙箱，并在运行
结束时销毁。

### 4. 爬虫

爬虫凭据必须与产品 API、Kratos、WeKnora 和用户工作区隔离：

| 变量 | 用途 | 备注 |
| --- | --- | --- |
| `CRAWLER_DATABASE_URL` | 爬虫专用 PostgreSQL | 不得复用身份或产品数据库 |
| `CRAWLER_S3_ACCESS_KEY_ID` | 原始附件归档桶访问标识 | 独立最小权限账号 |
| `CRAWLER_S3_SECRET_ACCESS_KEY` | 原始附件归档桶访问密钥 | 与上项成对轮换 |
| `CRAWLER_WEPEIYANG_TOKEN` | 青年湖底论坛只读访问 | 只发往固定 HTTPS 上游 |
| `CRAWLER_DAJIALA_KEY` | 大家来接口凭据 | 只在对应来源启用时提供 |
| `CRAWLER_GIT_USERNAME` | raw/Markdown Forgejo 同步用户 | 配合 Git token 使用 |
| `CRAWLER_GIT_TOKEN` | raw/Markdown Forgejo 推送凭据 | 通过 askpass 使用，不进 remote URL |
| `CRAWLER_LLM_API_KEY` | Canonical Markdown 优化模型 | 可选，不能复用用户模型 Key |
| `WEKNORA_API_KEY` | 派生资料注入/检索 | 仅限爬虫或 CLI 的 WeKnora 数据集 |

`CRAWLER_DATABASE_URL`、S3 endpoint、bucket、Git remote 和来源文件路径是配置
与秘密的混合入口，必须在日志中分别脱敏。带用户名、密码或 token 的 remote URL
一律拒绝。

### 5. WeKnora

WeKnora 是派生检索引擎，不是产品身份系统，也不是权限源。它自己的秘密应由
WeKnora 部署持有：

- `weknora_db_password`
- `weknora_redis_password`
- `weknora_jwt_secret`
- `weknora_aes_key`
- `weknora_chat_api_key`
- `weknora_embedding_api_key`
- `weknora_rerank_api_key`
- `weknora_llm_api_key`
- `weknora_tunnel_token`

这些值由 Ansible 注入目标机的 Compose secret 或 `0600` 文件。浏览器不直连
WeKnora，API Key 不进入知识库条目、发布快照或前端构建。

### 6. NewAPI 与身份服务

NewAPI、Kratos 和回退用 ZITADEL 都有自己的内部秘密：

- NewAPI 的数据库密码、会话密钥和初始管理员凭据；
- Kratos 数据库密码、Cookie/加密秘密和 SMTP 凭据；
- ZITADEL 的 master key、数据库密码、机器凭据和 SMTP 凭据。

这些凭据由对应 Ansible role 在目标机生成并保留，写入独立的 root-owned
`0600` 文件。已有部署不得因为某次 playbook 重跑而静默生成新密钥；文件缺失或
损坏应停止部署，先恢复备份。

ZITADEL 属于配对回退配置，不能与 Kratos 的活动配置并行注入到同一个 API 进程。
E2B 相关 Key 也属于旧执行适配器的隔离配置，不能混入 Kubernetes 沙箱的运行时
秘密。

### 7. CI/CD 与发布

GitHub Actions 只保存 CI/CD 自己需要的凭据：

| GitHub Secret | 用途 |
| --- | --- |
| `SERVER_READ_KEY` | 拉取私有 backend 子模块 |
| `CLI_READ_KEY` | 拉取私有/受限 CLI 子模块 |
| `CRAWLER_READ_KEY` | 拉取 crawler 子模块 |
| `GITLAB_SYNC_TOKEN` | 单向镜像状态同步 |
| `GITLAB_STATUS_TOKEN` | 回写 GitLab CI 状态 |
| `GITLAB_RELEASE_TOKEN` | 发布客户端包到 GitLab |
| `DEPLOY_SSH_KEY` | 生产部署专用 SSH 私钥 |
| `DEPLOY_KNOWN_HOSTS` | SSH host key 固定值 |
| `EDGEONE_TOKEN` | Web、Docs、Draw 的 EdgeOne 发布 |

`DEPLOY_HOST`、`DEPLOY_USER`、项目名和区域属于 GitHub Variables，不属于
Secrets。CI 不应把个人 SSH 私钥、个人 GitHub PAT 或服务运行时数据库密码带入
工作流。

## 统一注入规则

### 本地开发

本地只允许按职责使用独立文件：

| 文件 | 允许内容 |
| --- | --- |
| `.env.auth.local` | API 与本地认证/模型联调秘密 |
| `.env.image.local` | 图像脚本的服务端 API Key |
| `.env.toolchain.local` | SDK 和工具链路径，不放秘密 |
| `ops/auth/.env.local` | 本地身份服务邮件配置 |
| `ops/local/*.yml` 或 `ops/local/*.env` | Ansible 目标配置和服务部署秘密 |

根目录 `.env.local` 不得再作为跨组件秘密总表。迁移后，任务必须显式选择需要
的文件，不能因为 Taskfile 或 shell 自动加载而继承一整套无关凭据。

### 生产部署

生产秘密只从以下三种入口进入：

1. GitHub Actions Environment Secret：仅用于 CI/CD；
2. Ansible Vault 或受控本地变量：仅用于部署时传递；
3. 目标机 root-owned `0600` 文件或 Kubernetes Secret：仅用于运行时。

Ansible 模板必须使用 `no_log: true`，不把秘密写入任务输出、变更摘要或错误
消息。Compose、systemd 和 Kubernetes 只把必要的秘密挂载给单个进程。

### 用户级秘密

用户提供的模型 Key、Forgejo 授权、远程主机凭据和工作区临时解密密钥属于用户
级秘密，不得进入项目级 `.env`。它们应该：

- 由 API 绑定到已认证用户；
- 使用服务端密钥槽或外部 Secret Manager 加密保存；
- 在一次运行开始时按最小权限、最短 TTL 注入；
- 不进入模型上下文、笔记正文、发布快照、日志和错误响应；
- 在运行结束、取消或超时后撤销。

## 轮换与撤销

密钥记录至少要有以下字段：

| 字段 | 含义 |
| --- | --- |
| `owner` | 哪个服务或用户拥有它 |
| `scope` | 能访问什么资源 |
| `source` | GitHub、Ansible、目标机、Kubernetes 或用户密钥槽 |
| `created_at` | 创建时间 |
| `expires_at` | 到期时间；长期密钥也要有复查日期 |
| `last_verified_at` | 最近一次真实验证时间 |
| `rotation` | 轮换方式和是否需要双钥窗口 |
| `revocation` | 撤销入口和影响范围 |

轮换顺序遵循“先发后撤”：

1. 创建新的最小权限凭据；
2. 写入新的 Secret 位置；
3. 重启或热加载唯一消费进程；
4. 做不泄露值的健康检查；
5. 撤销旧凭据；
6. 更新密钥台账中的时间和验证结果。

会话签名密钥、数据库加密密钥和 WeKnora 的 `SYSTEM_AES_KEY` 不能按普通 API
Key 的方式随意轮换。它们要先确认数据迁移和旧值保留策略。

## 立即执行的清理顺序

不需要先重写所有变量名，按下面顺序就能降低风险：

1. 轮换根目录 `.env.local` 中的 GitLab 访问凭据，并把爬虫 Git 凭据移到爬虫
   专用配置；
2. 停止任何任务自动加载根 `.env.local`；
3. 为 API、sandbox controller、crawler、WeKnora、identity 和 NewAPI 各自建立
   独立的秘密清单；
4. 给每个生产秘密补上 owner、scope、到期/复查日期和撤销方法；
5. 将 GitHub Actions Secret、Ansible 变量、目标机文件和 Kubernetes Secret
   的命名映射固定下来；
6. 最后再做变量重命名和代码清理，重命名必须一次改完读取点、example、测试和
   部署模板。

整理的目标不是让所有组件共享一份“主 `.env`”，而是让每个组件都只拿到自己
需要的那几把钥匙。
