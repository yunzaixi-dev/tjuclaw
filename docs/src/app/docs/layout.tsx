import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { SiteFooter } from '@/components/SiteFooter';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <div className="wiki-layout-shell">
      <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
        {children}
      </DocsLayout>
      <SiteFooter />
    </div>
  );
}
