import Link from 'next/link';

interface FooterProps {
  icpNumber?: string;
  policeNumber?: string;
  policeUrl?: string;
}

export function SiteFooter({
  icpNumber = process.env.NEXT_PUBLIC_ICP_NUMBER || '津ICP备2026013377号',
  policeNumber = process.env.NEXT_PUBLIC_POLICE_BEIAN,
  policeUrl = process.env.NEXT_PUBLIC_POLICE_URL,
}: FooterProps) {
  const currentYear = 2026;

  return (
    <footer className="wiki-footer" role="contentinfo" aria-label="网站页尾">
      <div className="wiki-footer-inner">
        {/* Top Grid: Brand & Links */}
        <div className="wiki-footer-grid">
          <div className="wiki-footer-brand">
            <div className="wiki-footer-logo">
              <img src="/tjuclaw-icon.png" alt="TJUClaw Logo" width="28" height="28" />
              <strong>TJUClaw 2026</strong>
            </div>
            <p className="wiki-footer-tagline">
              基于确定性沙箱与长期记忆系统的天津大学智能体协同底座。
            </p>
            <div className="wiki-footer-meta">
              <span className="wiki-footer-badge">EdgeOne 加速</span>
              <span className="wiki-footer-badge">开源协同</span>
              <span className="wiki-footer-badge">全端矩阵</span>
            </div>
          </div>

          <div className="wiki-footer-nav-col">
            <h4 className="wiki-footer-heading">核心导航</h4>
            <ul className="wiki-footer-links">
              <li><Link href="/">平台首页</Link></li>
              <li><Link href="/docs">平台设计与概览</Link></li>
              <li><Link href="/docs/quickstart">快速开始</Link></li>
              <li><Link href="/docs/about">关于我们</Link></li>
              <li><Link href="/docs/terms">用户协议</Link></li>
              <li><Link href="/docs/privacy">隐私政策</Link></li>
            </ul>
          </div>

          <div className="wiki-footer-nav-col">
            <h4 className="wiki-footer-heading">开源代码仓库</h4>
            <ul className="wiki-footer-links">
              <li>
                <a href="https://github.com/yunzaixi-dev/tjuclaw" target="_blank" rel="noreferrer">
                  tjuclaw (主集成) ↗
                </a>
              </li>
              <li>
                <a href="https://github.com/yunzaixi-dev/tjuclaw-client" target="_blank" rel="noreferrer">
                  tjuclaw-client (全端客户端) ↗
                </a>
              </li>
              <li>
                <a href="https://github.com/yunzaixi-dev/tjuclaw-server" target="_blank" rel="noreferrer">
                  tjuclaw-server (后端 API) ↗
                </a>
              </li>
              <li>
                <a href="https://github.com/yunzaixi-dev/tjucli" target="_blank" rel="noreferrer">
                  tjucli (终端工具套件) ↗
                </a>
              </li>
              <li>
                <a href="https://github.com/yunzaixi-dev/tjuclaw-crawler" target="_blank" rel="noreferrer">
                  tjuclaw-crawler (情报采集) ↗
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar: Copyright & Filing Info */}
        <div className="wiki-footer-bottom">
          <div className="wiki-footer-copy">
            <span>&copy; {currentYear} TJUClaw Project. 遵循开源协作与规范。</span>
            <span className="wiki-footer-sep">|</span>
            <span>天津大学学生自主研发智能体协同系统</span>
          </div>

          <div className="wiki-footer-beian">
            {icpNumber && (
              <a
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noreferrer"
                className="wiki-footer-beian-link"
              >
                {icpNumber}
              </a>
            )}

            <a
              href={policeUrl || 'https://www.beian.gov.cn/'}
              target="_blank"
              rel="noreferrer"
              className="wiki-footer-police-link"
              aria-label={policeNumber || '公安备案'}
            >
              <img src="/images/gongan.png" alt="" width={16} height={16} />
              {policeNumber}
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
