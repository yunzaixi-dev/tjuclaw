---
title: CLI 下载与安装
description: 在 macOS、Linux、Windows 上安装 tjuclaw，校验下载，登录并连接自己的电脑。
---

# CLI 下载与安装

**产品命令是 `tjuclaw`**，用于账号登录、笔记同步和连接自己的电脑；`tjucli` 是独立的校园工具命令，两者不要混用。安装包支持 macOS、Linux、Windows 的 x64 与 arm64。

## 一键安装

### macOS / Linux

```bash
curl -fsSL https://tjuclaw-release.zaixi.dev/cli/install.sh | sh
```

脚本默认安装到 `~/.local/bin`，不需要 `sudo`，也不会修改 Shell 配置。如果安装后提示找不到命令，在当前终端运行：

```bash
export PATH="$HOME/.local/bin:$PATH"
tjuclaw version
```

需要永久生效时，将这行 `export PATH` 加入自己使用的 `~/.bashrc` 或 `~/.zshrc`，再打开新终端。

### Windows

在 **PowerShell** 中运行，而不是 CMD：

```powershell
irm https://tjuclaw-release.zaixi.dev/cli/install.ps1 | iex
```

默认安装到 `%LOCALAPPDATA%\Programs\tjuclaw`，加入当前用户的 PATH，不要求管理员权限。安装后可重新打开 PowerShell，再确认：

```powershell
tjuclaw version
```

## 安装脚本会做什么

脚本识别系统与处理器架构，从官方发布目录下载对应的二进制文件及 `SHA256SUMS`，**校验一致后才替换程序**；下载或校验失败就停止。Windows 安装包尚未提供代码签名，SHA256 校验不等于系统代码签名。

一键指令会执行远程脚本。希望先检查脚本，可以先保存文件、用文本编辑器阅读，再执行：

```bash
curl -fsSL https://tjuclaw-release.zaixi.dev/cli/install.sh -o install-tjuclaw.sh
# 阅读 install-tjuclaw.sh，确认后再运行
sh install-tjuclaw.sh
```

```powershell
Invoke-WebRequest https://tjuclaw-release.zaixi.dev/cli/install.ps1 -OutFile install-tjuclaw.ps1
# 阅读 install-tjuclaw.ps1，确认后再运行；遵循设备现有的执行策略
.\install-tjuclaw.ps1
```

可用环境变量 `TJUCLAW_VERSION` 固定版本（例如发布目录里已有的版本），或用 `TJUCLAW_INSTALL_DIR` 选择安装目录。不必为了安装而降低全局执行策略。

## 手动下载与校验

从[官方 CLI 发布目录](https://tjuclaw-release.zaixi.dev/cli/LATEST)获取当前版本号，再在 `cli/v<版本号>/` 下选择文件：

- macOS：`tjuclaw-darwin-arm64`（Apple Silicon）或 `tjuclaw-darwin-amd64`（Intel）。
- Linux：`tjuclaw-linux-arm64` 或 `tjuclaw-linux-amd64`。
- Windows：`tjuclaw-windows-arm64.exe` 或 `tjuclaw-windows-amd64.exe`。

同一版本目录提供 `SHA256SUMS`。可用 `sha256sum 文件名`（Linux）、`shasum -a 256 文件名`（macOS）或 `Get-FileHash 文件名 -Algorithm SHA256`（PowerShell），与清单对应文件的值逐字比较。校验通过后，Unix 系统赋予执行权限并命名为 `tjuclaw`；Windows 命名为 `tjuclaw.exe`，放入自己的 PATH 目录。

## 首次使用与更新

```bash
tjuclaw version
tjuclaw login
```

`login` 会给出设备登录指引；只在可信浏览器和自己的账号中完成授权，不把连接凭据放进笔记、源码仓库或聊天。

需要笔记同步时使用 `tjuclaw clone / status / diff / pull / push`；连接电脑的配置与能力授权见 [CLI 工作空间说明](https://github.com/yunzaixi-dev/tjucli/blob/release/WORKSPACES.md)。远程终端必须显式允许 `terminal.open`，拥有本机账号权限；安装 CLI 本身不会自动开放终端。

```bash
tjuclaw update --check
tjuclaw update
```

前者只检查，后者下载、校验并更新独立安装的 CLI，不降级。桌面客户端内置的 CLI 随客户端更新，不由这条指令替换。

完整远程 Coding Agent 仍在开发；Windows 终端能力与 Unix 不完全相同。可先在[产品使用指南](/docs/guide)确认已上线能力，再启用所需权限。
