import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import 'katex/dist/katex.min.css';
import { Geist, Geist_Mono } from 'next/font/google';
import type { Metadata } from 'next';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'TJUClaw 2026',
    template: '%s | TJUClaw 2026',
  },
  icons: {
    icon: '/tjuclaw-icon.svg',
  },
  description: '从单端口公网入口到嵌套虚拟化的 TJUClaw 工程手册。',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="zh-CN"
      className={`${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider
          search={{
            options: {
              type: 'static',
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
