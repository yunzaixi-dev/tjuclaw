import type { CSSProperties } from 'react';
import Link from 'next/link';

const chapters = [
  ['01', '快速开始', '安装、启动和第一次本地验证。', '/docs/quickstart'],
  ['02', '产品与架构', '理解 Web、API、Pi、tjucli 与校园服务的关系。', '/docs/architecture'],
  ['03', '使用指南', '从校园目标到可验证结果的产品使用方式。', '/docs/guide'],
];

const repositories = [
  {
    name: 'tjuclaw',
    status: '评审公开',
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
    desc: '基于 Go 1.27 构建，对接 Ory Kratos 会话体系，驱动 PostgreSQL 与 MeiliSearch 检索。',
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
    desc: '部署在腾讯云 EdgeOne 边缘节点，享受超低延迟云端 Agent 沙箱交互，带来堪比原生客户端的流畅体验。',
    action: '立即访问',
    href: 'https://app.tjuclaw.cloud',
    external: true,
    primary: true,
  },
  {
    name: 'Windows 桌面端',
    tag: 'x64 · 未签名 NSIS 安装包 (.exe)',
    desc: '将本地开发环境与文件系统深度链接到云端 Agent 沙箱，原生支持系统托盘与全局状态通知。',
    action: '下载 EXE',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-windows-x64-setup.exe',
    external: true,
  },
  {
    name: 'Linux 桌面端',
    tag: 'amd64 · Debian 软件包 (.deb)',
    desc: '为开发者无缝打通本地 Linux 工作区与云端 Agent 协同，支持 Wayland 原生渲染与 CLI 管道接入。',
    action: '下载 DEB',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-linux-amd64.deb',
    external: true,
  },
  {
    name: 'Android 移动端',
    tag: 'arm64 · 调试版安装包 (.apk)',
    desc: '随时随地便捷掌握智能体动态，无论在教室还是通勤途中，均可即时下发任务、调取资料与接收完成提醒。',
    action: '下载 APK',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-android-arm64-debug.apk',
    external: true,
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
              <div className={`wiki-platform-card ${p.primary ? 'is-primary' : ''}`} key={p.name}>
                <div className="wiki-platform-top">
                  <span className="wiki-platform-tag">{p.tag}</span>
                  <h3>{p.name}</h3>
                  <p>{p.desc}</p>
                </div>
                <div className="wiki-platform-bottom">
                  <a
                    className={`wiki-platform-btn ${p.primary ? 'is-btn-primary' : ''}`}
                    href={p.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {p.action} <span>{p.external ? '↗' : '→'}</span>
                  </a>
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
