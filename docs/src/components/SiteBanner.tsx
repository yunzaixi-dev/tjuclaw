'use client';

import { useSyncExternalStore } from 'react';
import { Banner } from 'fumadocs-ui/components/banner';

const CONTEST_BANNER_ID = 'tjuclaw-iterating-2026';
// Fumadocs stores dismiss as nd-banner-<base32(id)>
const CONTEST_BANNER_STORAGE_KEY = 'nd-banner-orvhky3mmf3s22lumvzgc5djnzts2mrqgi3a';

export function SiteBanner() {
  return (
    <Banner
      id={CONTEST_BANNER_ID}
      height="2.25rem"
      className="relative h-9 border-none px-12 text-black [&_button]:text-zinc-500 [&_button:hover]:text-black"
    >
      <div className="flex w-full items-center justify-center">
        <a
          href="/docs"
          className="font-mono text-[15px] font-black tracking-wide text-black underline decoration-2 underline-offset-2"
        >
          <span className="tjuclaw-banner-copy">🚧 TJUClaw 仍处于快速迭代期，未来将引入大量功能与优化，敬请期待 ✨</span>
        </a>
      </div>
    </Banner>
  );
}

// useSyncExternalStore 在 subscribe 引用变化时会重新订阅，故保持在模块级
const subscribeBannerDismissal = (onChange: () => void) => {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
};

export function ContestBannerRestore() {
  // 服务端快照固定为未关闭，避免 hydration 不一致
  const hidden = useSyncExternalStore(
    subscribeBannerDismissal,
    () => {
      try {
        return localStorage.getItem(CONTEST_BANNER_STORAGE_KEY) === 'true';
      } catch {
        return false;
      }
    },
    () => false,
  );

  if (!hidden) return null;

  return (
    <button
      type="button"
      className="wiki-footer-restore"
      onClick={() => {
        try {
          localStorage.removeItem(CONTEST_BANNER_STORAGE_KEY);
        } catch {
          // still reload so the banner can show for this visit
        }
        location.reload();
      }}
    >
      显示公告
    </button>
  );
}
