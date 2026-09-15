import type { CSSProperties } from 'react';
import Link from 'next/link';

const chapters = [
  ['01', '快速开始', '安装、启动和第一次本地验证。', '/docs/quickstart'],
  ['02', '产品与架构', '理解 Web、API、Pi、tjucli 与校园服务的关系。', '/docs/blog/architecture'],
  ['03', '使用指南', '从校园目标到可验证结果的产品使用方式。', '/docs/blog/guide'],
  ['04', '技术博客', '多篇专题深度剖析架构演进与攻坚历程。', '/docs/blog'],
];

const repositories = [
  {
    name: 'tjuclaw',
    status: '访问受限',
    lang: 'TypeScript (Node >=22) · Next.js 16.3',
    scope: '工程集成 / 文档 / 云边运维',
    desc: '系统总体集成仓库，包含 Next.js 16 静态文档站、Ansible 部署声明与 Taskfile 统一指令。',
    path: '根目录 (Root)',
    href: 'https://github.com/yunzaixi-dev/tjuclaw',
  },
  {
    name: 'tjuclaw-client',
    status: '完全开源',
    lang: 'TypeScript · React 19.2 · Tauri v2 (Rust 1.97)',
    scope: '多端客户端 / 工作空间',
    desc: '基于 React 19 + Vite + Tauri 构建，覆盖 Web (EdgeOne)、Windows、Linux 与 Android。',
    path: 'frontend/',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client',
  },
  {
    name: 'tjuclaw-server',
    status: '竞赛私有',
    lang: 'Go 1.27.0',
    scope: '核心后端 API / 存储 / 认证网关',
    desc: '基于 Go 1.27 构建，提供同源会话认证、任务记录与工作空间管理 API。',
    path: 'backend/',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-server',
  },
  {
    name: 'tjucli',
    status: '竞赛私有',
    lang: 'Go 1.27.0',
    scope: '校园能力 CLI / Tool Server',
    desc: '独立自包含的 Go 工具管道与标准服务，将真实校园服务抽象为智能体确定性执行指令。',
    path: 'cli/',
    href: 'https://github.com/yunzaixi-dev/tjucli',
  },
  {
    name: 'tjuclaw-crawler',
    status: '竞赛私有',
    lang: 'TypeScript · Bun 1.3 · PostgreSQL',
    scope: '校园情报摄取 / RSS 管道',
    desc: '基于轻量 Bun 运行时构建的高性能情报采集与重放服务，统一汇聚至 PostgreSQL，持续输出标准化校园动态与资料库事件流。',
    path: 'crawler/',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-crawler',
  },
];

const platforms = [
  {
    name: 'Web 云端版',
    tag: '无需安装 · 浏览器即用',
    desc: '通过浏览器登录、创建任务并查看工作空间。云端智能体与沙箱执行链路仍在接入中。',
    action: '立即访问',
    href: 'https://app.tjuclaw.cloud',
    external: true,
    primary: true,
    available: true,
  },
  {
    name: 'Windows 桌面端',
    tag: 'x64 · 未签名 NSIS 安装包 (.exe)',
    desc: '基于 Tauri 的 Windows 客户端，与 Web 共享登录、任务与工作空间界面。',
    action: '下载 EXE',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-windows-x64-setup.exe',
    external: true,
    available: true,
  },
  {
    name: 'Linux 桌面端',
    tag: 'amd64 · Debian 软件包 (.deb)',
    desc: '面向 Linux 的桌面客户端，提供 Debian 软件包，与 Web 共享任务与工作空间界面。',
    action: '下载 DEB',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-linux-amd64.deb',
    external: true,
    available: true,
  },
  {
    name: 'Android 移动端',
    tag: 'arm64 · 调试版安装包 (.apk)',
    desc: '在 Android 设备上体验登录、任务与工作空间界面；当前提供用于验证的调试版安装包。',
    action: '下载 APK',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-android-arm64-debug.apk',
    external: true,
    available: true,
  },
  {
    name: 'iOS 移动端',
    tag: '规划适配 · TestFlight 筹备中',
    desc: '为 iPhone 与 iPad 打造的原生移动端体验，深度适配 iOS 原生交互与离线会话缓存。',
    action: '筹备中',
    href: '#',
    external: false,
    available: false,
  },
  {
    name: 'macOS 桌面端',
    tag: '规划适配 · Apple Silicon 原生',
    desc: '基于 Tauri v2 适配 macOS，支持 Menu Bar 快捷常驻、Raycast 联动与本地终端工作区穿透。',
    action: '筹备中',
    href: '#',
    external: false,
    available: false,
  },
  {
    name: 'HarmonyOS 鸿蒙',
    tag: '规划适配 · ArkUI 原生形态',
    desc: '面向华为鸿蒙生态设备优化，支持分布式跨端流转、智慧多窗协同与端侧即时情报卡片。',
    action: '筹备中',
    href: '#',
    external: false,
    available: false,
  },
  {
    name: 'CLI 终端工具',
    tag: '架构对接 · tjucli 独立命令',
    desc: '面向极客开发者的纯终端工作流，支持一键在 Shell 中下发任务、管道过滤资料与自动化脚本集成。',
    action: '即将开放',
    href: '#',
    external: false,
    available: false,
  },
];

export default function HomePage() {
  return (
    <main className="wiki-home">
      <section className="wiki-hero">
        <div className="wiki-hero-copy">
          <p className="wiki-kicker">天津大学 AI 智能体大赛 · 2026</p>
          <h1><span>面向天津大学校园场景优化的</span><span>通用智能体平台</span></h1>
          <p className="wiki-lead">让整个校园，成为 Agent 可编程的世界。</p>
          <div className="wiki-actions">
            <a className="wiki-primary" href="https://app.tjuclaw.cloud" target="_blank" rel="noreferrer">进入应用 <span>↗</span></a>
            <Link className="wiki-secondary" href="/docs">进入工程 Wiki <span>→</span></Link>
          </div>
        </div>
      </section>

      <section className="wiki-platforms" aria-label="支持的平台与客户端">
        <div className="wiki-platforms-inner">
          <div className="wiki-platforms-header">
            <h2>全平台客户端与服务入口</h2>
            <p>一套代码跨端覆盖，随时随地接入天津大学专属校园智能体平台。</p>
          </div>
          <div className="wiki-platforms-grid">
            {platforms.map((p) => (
              <div
                className={`wiki-platform-card ${p.primary ? 'is-primary' : ''} ${!p.available ? 'is-disabled' : ''}`}
                key={p.name}
              >
                <div className="wiki-platform-top">
                  <span className="wiki-platform-tag">{p.tag}</span>
                  <h3>{p.name}</h3>
                  <p>{p.desc}</p>
                </div>
                <div className="wiki-platform-bottom">
                  {p.available ? (
                    <a
                      className={`wiki-platform-btn ${p.primary ? 'is-btn-primary' : ''}`}
                      href={p.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {p.action} <span>{p.external ? '↗' : '→'}</span>
                    </a>
                  ) : (
                    <span className="wiki-platform-btn is-btn-disabled" aria-disabled="true">
                      {p.action} <span className="wiki-platform-btn-lock">🔒</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="wiki-facts" aria-label="项目定位">
        <div><span>01 / DOMAIN</span><strong>校园</strong><p>围绕课程资料、校园信息与学生日常任务优化。</p></div>
        <div><span>02 / RUNTIME</span><strong>云端</strong><p>让智能体跨 Web、桌面与移动端协同工作。</p></div>
        <div><span>03 / OUTPUT</span><strong>结果</strong><p>留下来源、状态和产物，而不是只返回一段回答。</p></div>
      </section>

      <section className="wiki-chapters">
        <div className="wiki-section-title"><h2>认识 TJUClaw。</h2><p>这里介绍产品定位、核心能力、使用方式与参赛信息，帮助评审和校园用户快速理解这套平台能解决什么问题。</p></div>
        {chapters.map(([id, title, description, href]) => <Link className="wiki-chapter" href={href} key={id}><span>{id}</span><strong>{title}</strong><p>{description}</p><b>→</b></Link>)}
      </section>

      <section className="wiki-repos" aria-label="开源代码仓库划分">
        <div className="wiki-section-title">
          <h2>开源代码矩阵与模块划分。</h2>
          <p>TJUClaw 采用高内聚、低耦合的多仓协同架构，各模块权责清晰、独立演进。</p>
        </div>
        <div className="wiki-repos-grid">
          {repositories.map((repo) => (
            <a
              key={repo.name}
              className="wiki-repo-card"
              href={repo.href}
              target="_blank"
              rel="noreferrer"
            >
              <div className="wiki-repo-top">
                <span className="wiki-repo-path">{repo.path}</span>
                <span className="wiki-repo-status">{repo.status}</span>
                <span className="wiki-repo-arrow">↗</span>
              </div>
              <strong className="wiki-repo-name">{repo.name}</strong>
              <div className="wiki-repo-scope">{repo.scope}</div>
              <div className="wiki-repo-lang">{repo.lang}</div>
              <p className="wiki-repo-desc">{repo.desc}</p>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
