import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="wiki-home">
      <section className="wiki-hero">
        <div className="wiki-hero-copy">
          <p className="wiki-kicker">TJUCLAW</p>
          <h1>
            <span>项目文档，</span>
            <span>从这里开始。</span>
          </h1>
          <p className="wiki-lead">
            开发环境与协作说明。当前为开发基线，不代表产品功能已经上线。
          </p>
          <div className="wiki-actions">
            <Link className="wiki-primary" href="/docs">
              阅读文档
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
