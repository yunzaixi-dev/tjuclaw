# Ansible：渐进接管现有主机

提供**只读盘点**、**本地 HAProxy 回源候选生成**和独立的 **API 发布/回滚**。
`deploy-api.yml` 仅管理 `tjuclaw-api` 服务；现有代理、校园 VPN、身份服务和防火墙继续由原方式管理。
发布前置配置与验证范围见 [部署说明](DEPLOY.md)。

## 工具与本地配置

使用 Python 3.11+、uv 和 OpenSSH。Ansible 版本固定在 `requirements.txt`；
根 Task 命令用 uv 隔离运行，不修改系统 Python。

1. 把 `inventory.example.yml` 复制到被忽略的 `ops/local/ansible-inventory.yml`，
   填入经确认的 SSH 主机别名与用户。不要猜测已有别名对应哪台服务器。
2. 先通过常规 SSH 核对主机身份与 host key。保持 Ansible host key 检查开启。
3. 执行 `task ops:discover`。需要 sudo 才能读取服务信息时，由本地 inventory 设置
   `ansible_become: true`；密码通过交互或加密凭据提供，不能写进仓库。

盘点输出仅包含系统概况、服务状态、监听端口和容器名称/镜像/状态/端口，
不读取容器环境变量、配置文件内容、私钥或 EasyConnect 登录态。
输出仍包含基础设施信息，需要保存时放在 `ops/local/` 或 `test-results/`，不要发布到 Wiki。

## 独立 HTTPS 回源入口

目标链路：浏览器 HTTPS 443 → EdgeOne（承载前端、文档与 Slides；同源 `/api` 与 `/api/*` 回源）→ HAProxy 专用 HTTPS 回源监听 → 本地直连 Go API。
腾讯云核心主机仅承载后端服务（直连 Go API、Kratos、内部服务等），主机上不部署 Nginx、静态 Web 容器或应用网关。
`8443` 只是候选端口，应用前必须核实 EdgeOne 产品支持范围（如自定义回源端口支持）、主机现有端口占用、安全组和防火墙。
不挪用已有 443 监听，不通过普通网站 CDN/EdgeOne 承载 VPN 或任意代理协议。

```bash
cp ops/ansible/origin.example.yml ops/local/origin.yml
# 编辑真实域名、证书路径、直连 Go API 地址（示例 18080 仅为回环绑定示例，非线上实测事实）和核实过的回源地址段。
task ops:origin:render
```

候选文件写到被忽略的 `ops/local/ansible-origin/haproxy-origin.cfg`，权限为 0600。
它是独立语法检查用配置，**不能覆盖现有 haproxy.cfg**。现有 global/defaults、
证书布局、配置加载方式和 reload 能力明确后，才将 frontend/backend 部分合并到现有配置。
目标主机使用对应版本 `haproxy -c -f <candidate>` 检查，证书路径必须存在。
当前后端检查为 HTTP `GET /healthz`，要求返回 200；它不能替代认证和流式请求的验收。

回源流量路由与转发规则：

- **同源路径限制与前缀剥离**：HAProxy 回源监听仅接受同源 `/api` 或 `/api/*` 请求，其余非 `/api` 路径返回 404（来源或 Host 不符仍返回 403）。转发至后端 Go API 前精确剥离一次 `/api` 前缀（Go API 自身路由挂载在根路径，如 `/healthz`、`/tasks`）。
- **保留 Host 与 HTTPS 转发头**：保留浏览器原始请求的 Host，并设置 `X-Forwarded-Proto https` 与 `X-Forwarded-Port 443`。
- **直连 Go API**：后端直接转发给 Go API（示例回环绑定 `127.0.0.1:18080`，仅为本地回环示例，非线上实测事实），无需在主机上部署 Nginx 或应用网关。
- **绝不对外暴露内部端点**：内部工具服务（`tjucli-server`）、Kratos admin 端口、数据库与沙箱环境绝不能作为公开回源路由。
- 当前根 Compose 是本地冒烟环境，不能原样作为生产部署。

EdgeOne 侧回源与缓存要求（需核实产品支持）：
- **保留 `/api` 前缀与原始 Host/SNI**：EdgeOne 必须在回源请求中保留原始 `/api` 路径前缀以及公开 Host/SNI，以便 HAProxy 执行 ACL 判定、路径剥离及头信息保留。
- **API 与认证禁用缓存**：`/api/*` 以及所有认证相关请求必须严格配置为不缓存（no-cache / bypass cache），防止凭据与会话泄露。
- **流式响应与长连接**：SSE 流式响应必须禁用边缘缓冲并核实连接超时；单独验收 WebSocket 支持。
- **待核实的 EdgeOne 具体能力**：EdgeOne 是否支持基于路径（Path-based）的精确回源规则（静态内容走边缘存储或 Pages，`/api/*` 独立回源至自定义端口如 8443）、自定义回源端口支持范围，以及自定义回源鉴权头（如 Header 鉴权或 mTLS）等，均需结合控制台与官方文档实测核实，不预设未经核实的产品行为。

回源还需逐项核实：

- HTTPS 证书、SNI、回源 Host 与页面域名保持一致，开启源站证书校验。
- 回源来源列表取自官方且需要更新；示例地址段没有实际部署用途。
- 共享 CDN/EdgeOne 的 IP 白名单不是租户身份认证。正式开放前配置经过验证的回源鉴权（例如产品支持的 mTLS 或专用请求头），并明确后端信任哪些转发头。
- 本方案没有更改任何校园 VPN、路由或 SSH 策略。Kratos 策略调整遵循 `../auth/README.md`。
- 真实主机名、公网 IP、SSH 别名和凭据保存在本地忽略目录或 CI 环境配置中。候选回源生成不会 reload 或覆盖线上入口。

## 幂等验收与后续接管

`task ops:check` 执行本地语法检查，不连接远端；`task ops:test` 在临时目录执行
候选生成的幂等与非法来源拒绝回归，不连接远端。
盘点命令预期每次 `changed=0`；候选渲染第一次创建文件，第二次应 `changed=0`。
`--check` 不能证明生产更新无损，也不能替代真实连通验证。

每个服务进入正式管理前，先记录：启动方式、配置归属、挂载/卷、镜像 digest、
网络依赖、备份恢复路径，以及 SSH 是否依赖该服务。基于实测状态形成明确目标，
再实现各自的部署角色。发布应用不会顺带更新身份服务或校园 VPN。

接管后的变更验收应同时满足：第二次执行 `changed=0`、未发生额外 reload/restart、
未变更服务的容器 ID 不变、公网/校园访问与管理连接正常。
不要用 `docker compose down && up`、强制重建或无条件 shell 命令掩盖状态差异。
