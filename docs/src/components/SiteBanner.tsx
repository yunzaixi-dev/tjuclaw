'use client';

import { useEffect, useState } from 'react';
import { Banner } from 'fumadocs-ui/components/banner';

const CONTEST_BANNER_ID = 'tjuclaw-contest-2026';
// Fumadocs stores dismiss as nd-banner-<base32(id)>
const CONTEST_BANNER_STORAGE_KEY = 'nd-banner-orvhky3mmf3s2y3pnz2gk43ufuzdamrw';

export function SiteBanner() {
  return (
    <Banner
      id={CONTEST_BANNER_ID}
      height="2.25rem"
      className="relative h-9 border-none px-12 text-black [&_button]:text-zinc-500 [&_button:hover]:text-black"
    >
      <div className="flex w-full items-center justify-center">
        <a
          href="https://agent2026.tju.edu.cn/ai-competition/introduction/"
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[15px] font-black tracking-wide text-black underline decoration-2 underline-offset-2"
        >
          🎉 此作品正在参加天津大学智能体大赛 2026，希望大家能投我们一票，感谢 🥳
        </a>
      </div>
    </Banner>
  );
}

export function ContestBannerRestore() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(CONTEST_BANNER_STORAGE_KEY) === 'true');
    } catch {
      setHidden(false);
    }
  }, []);

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
