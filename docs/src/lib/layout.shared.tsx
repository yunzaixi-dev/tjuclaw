import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="docs-brand">
          <img src="/tjuclaw-icon.webp" alt="" width="28" height="28" />
          <span>{appName}</span>
        </span>
      ),
    },
    links: [
      {
        text: '开发文档',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: '服务状态',
        url: 'https://status.tjuclaw.cloud/',
        external: true,
      },
      {
        text: '更新日志',
        url: 'https://changelog.tjuclaw.cloud/',
        external: true,
      },
    ],
  };
}
