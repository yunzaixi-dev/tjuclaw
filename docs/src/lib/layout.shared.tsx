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
    ],
  };
}
