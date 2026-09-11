import type { CSSProperties } from 'react';
import Link from 'next/link';

const chapters = [
  ['01', '快速开始', '安装、启动和第一次本地验证。', '/docs/dev/quickstart'],
  ['02', '产品与架构', '理解 Web、API、Pi、tjucli 与校园服务的关系。', '/docs/dev/architecture'],
  ['03', '使用指南', '从校园目标到可验证结果的产品使用方式。', '/docs/user/guide'],
];

const platforms = [
  {
    name: 'Web 云端版',
    tag: '无需安装 · 浏览器即用',
    desc: '基于 EdgeOne 全球加速与 Kratos 会话管理，提供完整的任务工作空间。',
    action: '立即访问',
    href: 'https://tjuclaw.cloud',
    external: true,
    primary: true,
  },
  {
    name: 'Windows 桌面端',
    tag: 'x64 · 未签名 NSIS 安装包 (.exe)',
    desc: '集成 WebView2 容器，原生支持系统托盘与本地沙箱持久化。',
    action: '下载 EXE',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-windows-x64-setup.exe',
    external: true,
  },
  {
    name: 'Linux 桌面端',
    tag: 'amd64 · Debian 软件包 (.deb)',
    desc: '面向 Ubuntu / Debian 深度优化，支持 Wayland 与原生通知交互。',
    action: '下载 DEB',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client/releases/latest/download/TJUClaw-linux-amd64.deb',
    external: true,
  },
  {
    name: 'Android 移动端',
    tag: 'arm64 · 调试版安装包 (.apk)',
    desc: '专为学生移动场景定制，支持课程资料即时调取与端上任务通知。',
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
          <p className="wiki-lead">参赛选手：TJUClaw 项目团队</p>
          <div className="wiki-actions">
            <a className="wiki-primary" href="https://tjuclaw.cloud" target="_blank" rel="noreferrer">访问 Web 端 (tjuclaw.cloud) <span>↗</span></a>
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
    </main>
  );
}
