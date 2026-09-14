import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { SiteFooter } from '@/components/SiteFooter';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <div className="wiki-layout-shell">
      <HomeLayout {...baseOptions()}>
        {children}
      </HomeLayout>
      <SiteFooter />
    </div>
  );

}
