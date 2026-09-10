import type { CSSProperties } from 'react';
import Link from 'next/link';

const chapters = [
  ['01', '快速开始', '安装、启动和第一次本地验证。', '/docs'],
  ['02', '产品与架构', '理解 Web、API、Pi、tjucli 与校园服务的关系。', '/docs'],
  ['03', '使用指南', '从校园目标到可验证结果的产品使用方式。', '/docs'],
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
            <Link className="wiki-primary" href="/docs">进入工程 Wiki <span>→</span></Link>
            <Link className="wiki-secondary" href="/docs/presentation">查看项目演示 <span>↗</span></Link>
          </div>
        </div>
        <div className="wiki-stack" aria-label="TJUClaw 平台能力层">
          <div className="wiki-stack-heading"><span>PLATFORM / 2026</span><span>ONLINE MODEL</span></div>
          <div className="wiki-layer" style={{ '--layer': 1 } as CSSProperties}><span className="wiki-layer-id">01</span><strong>校园场景</strong><span>天津大学</span></div>
          <div className="wiki-layer" style={{ '--layer': 2 } as CSSProperties}><span className="wiki-layer-id">02</span><strong>通用智能体</strong><span>Pi + Skill</span></div>
          <div className="wiki-layer" style={{ '--layer': 3 } as CSSProperties}><span className="wiki-layer-id">03</span><strong>跨平台云端</strong><span>Web / Native</span></div>
          <div className="wiki-layer" style={{ '--layer': 4 } as CSSProperties}><span className="wiki-layer-id">04</span><strong>可验证结果</strong><span>Trace / Artifact</span></div>
          <p className="wiki-pulse"><span /> SYSTEM READY · DOCUMENTATION BASELINE</p>
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
