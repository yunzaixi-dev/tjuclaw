import type { CSSProperties } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  BookText,
  Brain,
  CalendarDays,
  Check,
  FilePlus2,
  FileSearch,
  Files,
  Globe,
  Laptop,
  Lightbulb,
  MessageCircle,
  LibraryBig,
  Monitor,
  Network,
  Newspaper,
  PenLine,
  Smartphone,
  Sparkles,
  Tablet,
  Terminal,
  Wrench,
} from 'lucide-react';

const chapters: { title: string; description: string; href: string; icon: LucideIcon; tone: string }[] = [
  { title: '使用指南', description: '登录、整理资料、使用智能体与共享知识库。', href: '/docs/guide', icon: BookOpen, tone: 'blue' },
  { title: '平台架构', description: '了解 TJUClaw 系统核心设计原则。', href: '/docs', icon: Network, tone: 'purple' },
  { title: '技术博客', description: '深入解析多源数据复杂采集、脱敏与向量化。', href: '/docs/blog/data-pipeline', icon: PenLine, tone: 'orange' },
];

const platformIcons: Record<string, LucideIcon> = {
  'Web 云端版': Globe,
  'Windows 桌面端': Monitor,
  'Linux 桌面端': Laptop,
  'Android 移动端': Smartphone,
  'iOS 移动端': Tablet,
  'macOS 桌面端': Laptop,
  'HarmonyOS 鸿蒙': AppWindow,
  'CLI 终端工具': Terminal,
};

const floaters: { icon: LucideIcon; className: string }[] = [
  { icon: BookOpen, className: 'is-book' },
  { icon: Check, className: 'is-check' },
  { icon: Globe, className: 'is-globe' },
  { icon: Lightbulb, className: 'is-bulb' },
  { icon: Files, className: 'is-files' },
];

const repositories = [
  {
    name: 'tjuclaw',
    status: '开源',
    lang: 'TypeScript (Node >=22) · Next.js 16.3',
    scope: '工程集成 / 文档 / 云边运维',
    desc: '系统总体集成仓库，包含 Next.js 16 静态文档站、Ansible 部署声明与 Taskfile 统一指令。',
    path: '根目录 (Root)',
    href: 'https://github.com/yunzaixi-dev/tjuclaw',
  },
  {
    name: 'tjuclaw-client',
    status: '开源',
    lang: 'TypeScript · React 19.2 · Tauri v2 (Rust 1.97)',
    scope: '多端客户端 / 工作空间',
    desc: '基于 React 19 + Vite + Tauri 构建，覆盖 Web (EdgeOne)、Windows、Linux 与 Android。',
    path: 'frontend/',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-client',
  },
  {
    name: 'tjuclaw-server',
    status: '闭源',
    lang: 'Go 1.27.0',
    scope: '核心后端 API / 存储 / 认证网关',
    desc: '基于 Go 1.27 构建，提供同源会话认证、任务记录与工作空间管理 API。',
    path: 'backend/',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-server',
  },
  {
    name: 'tjuclaw-sandbox',
    status: '闭源',
    lang: 'Kubernetes · OCI · Linux',
    scope: '自建 Agent 执行沙箱',
    desc: '面向不可信 Agent 代码的自建 Kubernetes 运行时，负责临时 Run 隔离、工作区契约、资源预算与网络边界。',
    path: 'sandbox/',
    href: 'https://github.com/yunzaixi-dev/tjuclaw-sandbox',
  },
  {
    name: 'tjucli',
    status: '开源',
    lang: 'Go 1.27.0',
    scope: '校园能力 CLI / Tool Server',
    desc: '独立自包含的 Go 工具管道与标准服务，将真实校园服务抽象为智能体确定性执行指令。',
    path: 'cli/',
    href: 'https://github.com/yunzaixi-dev/tjucli',
  },
  {
    name: 'tjuclaw-crawler',
    status: '闭源',
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
    href: 'https://tjuclaw-release.zaixi.dev/client/latest/TJUClaw-windows-x64-setup.exe',
    external: true,
    available: true,
  },
  {
    name: 'Linux 桌面端',
    tag: 'amd64 · Debian 软件包 (.deb)',
    desc: '面向 Linux 的桌面客户端，提供 Debian 软件包，与 Web 共享任务与工作空间界面。',
    action: '下载 DEB',
    href: 'https://tjuclaw-release.zaixi.dev/client/latest/TJUClaw-linux-amd64.deb',
    external: true,
    available: true,
  },
  {
    name: 'Android 移动端',
    tag: 'arm64 · 正式签名安装包 (.apk)',
    desc: '在 Android 设备上使用登录、任务与工作空间；固定签名，新版本可直接覆盖安装并保留数据。',
    action: '下载 APK',
    href: 'https://tjuclaw-release.zaixi.dev/client/latest/TJUClaw-android-arm64.apk',
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


/** The real notes page (a screenshot of the Web client), light or dark to match the reader. */
function HeroShot() {
  return (
    <div className="nx-mock nx-shot">
      <div className="nx-mock-bar" aria-hidden="true">
        <span /><span /><span />
        <em>app.tjuclaw.cloud</em>
      </div>
      <picture>
        <source srcSet="/images/home-notes-dark.webp" media="(prefers-color-scheme: dark)" />
        <img src="/images/home-notes-light.webp" width={1920} height={1080} alt="TJUClaw 的笔记页面：左侧是文件与记忆闪卡，右侧是以所见即所得方式编辑的《基尔霍夫定律》笔记。" />
      </picture>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="nx-home">
      <section className="nx-hero">
        <div className="nx-floaters" aria-hidden="true">
          {floaters.map(({ icon: Icon, className }) => (
            <span className={`nx-floater ${className}`} key={className}><Icon size={30} strokeWidth={1.6} /></span>
          ))}
        </div>
        <a
          className="nx-pill"
          href="https://agent2026.tju.edu.cn/ai-competition/introduction/"
          target="_blank"
          rel="noreferrer"
        >
          <span className="nx-pill-dot" />天津大学 AI 智能体大赛 2026 参赛作品<ArrowRight size={14} />
        </a>
        <h1>让整个校园，<br />成为 Agent 可编程的世界。</h1>
        <p className="nx-lead">面向天津大学校园场景优化的通用智能体平台。课程资料、校园信息与日常任务，在同一个工作空间里交给智能体。</p>
        <div className="nx-actions">
          <a className="nx-btn is-primary" href="https://app.tjuclaw.cloud" target="_blank" rel="noreferrer">进入应用</a>
          <Link className="nx-btn is-secondary" href="/docs">阅读文档</Link>
        </div>
        <div className="nx-hero-media">
          <HeroShot />
          <p className="nx-caption">真实界面 · 笔记页面</p>
        </div>
      </section>

      <section className="nx-strip" aria-label="覆盖的平台">
        <p>一套代码，覆盖浏览器、桌面、移动端与终端</p>
        <ul>
          {platforms.map((p) => <li key={p.name}>{p.name.replace(/\s.*$/, '')}</li>)}
        </ul>
      </section>

      <section className="nx-section">
        <header className="nx-head">
          <h2>为校园场景而生的智能体。</h2>
          <p>围绕课程资料、校园信息与学生日常任务优化，而不是又一个通用聊天框。</p>
        </header>
        <div className="nx-bento">
          <article className="nx-card is-wide tone-blue">
            <div className="nx-card-copy">
              <span className="nx-eyebrow">校园</span>
              <h3>一个工作空间，整合课程资料与校园信息。</h3>
              <p>把讲义、通知与校园动态汇聚到同一处，智能体按需检索，不必在十几个网站间来回切换。</p>
              <Link className="nx-link" href="/docs/guide">了解使用方式<ArrowRight size={16} /></Link>
            </div>
            <div className="nx-card-art nx-art-list" aria-hidden="true">
              <i><BookText size={16} />第 4 讲 · 树与二叉树.pdf</i>
              <i><Newspaper size={16} />教务通知 · 选课时间调整</i>
              <i><Files size={16} />作业 3 · 要求与评分标准</i>
              <i><Globe size={16} />图书馆 · 开放时间</i>
            </div>
          </article>
          <article className="nx-card tone-yellow">
            <span className="nx-eyebrow">云端</span>
            <h3>跨端协同，随时接续。</h3>
            <p>Web、桌面与移动端共享登录、任务与工作空间，换一台设备也能从上次停下的地方继续。</p>
            <div className="nx-card-art nx-art-devices" aria-hidden="true">
              <Monitor size={40} strokeWidth={1.4} /><Laptop size={40} strokeWidth={1.4} /><Smartphone size={34} strokeWidth={1.4} />
            </div>
          </article>
          <article className="nx-card tone-purple">
            <span className="nx-eyebrow">结果</span>
            <h3>不只是回答，而是留下结果。</h3>
            <p>每次任务都保留来源、状态和产物，便于回看、核对与分享。</p>
            <div className="nx-card-art nx-art-status" aria-hidden="true">
              <i className="is-done"><Check size={14} />来源已引用</i>
              <i className="is-done"><Check size={14} />产物已保存</i>
            </div>
          </article>
        </div>
      </section>

      <section className="nx-section">
        <header className="nx-head">
          <h2>从这里开始认识 TJUClaw。</h2>
          <p>产品定位、核心能力、使用方式与参赛信息，帮助评审和校园用户快速理解这套平台。</p>
        </header>
        <div className="nx-tiles is-three">
          {chapters.map(({ title, description, href, icon: Icon, tone }) => (
            <Link className="nx-tile" href={href} key={title}>
              <span className={`nx-icon tone-${tone}`}><Icon size={20} /></span>
              <strong>{title}</strong>
              <p>{description}</p>
              <ArrowRight className="nx-tile-arrow" size={18} />
            </Link>
          ))}
        </div>
      </section>

      <section className="nx-section" aria-label="支持的平台与客户端">
        <header className="nx-head">
          <h2>随时随地，接入校园智能体。</h2>
          <p>一套代码跨端覆盖，从浏览器到桌面与手机。</p>
        </header>
        <div className="nx-tiles is-four">
          {platforms.map((p) => {
            const Icon = platformIcons[p.name] ?? AppWindow;
            const body = (
              <>
                <span className={`nx-icon ${p.available ? 'tone-blue' : 'tone-gray'}`}><Icon size={20} /></span>
                <strong>{p.name}</strong>
                <span className="nx-tile-tag">{p.tag}</span>
                <p>{p.desc}</p>
                {p.available
                  ? <span className="nx-tile-action">{p.action}<ArrowUpRight size={16} /></span>
                  : <span className="nx-tile-badge">{p.action}</span>}
              </>
            );
            return p.available ? (
              <a className={`nx-tile ${p.primary ? 'is-featured' : ''}`} href={p.href} target="_blank" rel="noreferrer" key={p.name}>{body}</a>
            ) : (
              <div className="nx-tile is-disabled" key={p.name}>{body}</div>
            );
          })}
        </div>
      </section>

      <section className="nx-section" aria-label="代码仓库划分">
        <header className="nx-head">
          <h2>代码矩阵与模块划分。</h2>
          <p>TJUClaw 由开源产品组件与闭源执行基础设施共同组成。完整源码、流水线状态与开发动态请通过仓库入口查看。</p>
        </header>
        <div className="nx-repos">
          {repositories.map((repo) => (
            <a key={repo.name} className="nx-repo" href={repo.href} target="_blank" rel="noreferrer">
              <div className="nx-repo-top">
                <code>{repo.path}</code>
                <span className={repo.status === '开源' ? 'is-open' : ''}>{repo.status}</span>
                <ArrowUpRight className="nx-repo-arrow" size={16} />
              </div>
              <strong>{repo.name}</strong>
              <em>{repo.scope}</em>
              <p>{repo.desc}</p>
              <small>{repo.lang}</small>
            </a>
          ))}
        </div>
      </section>

      <section className="nx-cta">
        <img src="/tjuclaw-icon.webp" alt="" width="72" height="72" />
        <h2>现在就开始使用 TJUClaw。</h2>
        <p>浏览器打开即可登录，无需安装。</p>
        <div className="nx-actions">
          <a className="nx-btn is-primary" href="https://app.tjuclaw.cloud" target="_blank" rel="noreferrer">进入应用</a>
          <Link className="nx-btn is-secondary" href="/docs/guide">查看使用指南</Link>
        </div>
      </section>
    </main>
  );
}
