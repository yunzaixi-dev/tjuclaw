import { Banner } from 'fumadocs-ui/components/banner';

export function SiteBanner() {
  return (
    <Banner
      id="tjuclaw-contest-2026"
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
