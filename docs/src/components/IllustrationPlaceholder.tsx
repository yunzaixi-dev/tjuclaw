
interface IllustrationPlaceholderProps {
  id?: string;
  title: string;
  description?: string;
  aspectRatio?: '16/9' | '4/3' | '21/9' | 'auto';
  className?: string;
}

export function IllustrationPlaceholder({
  id,
  title,
  description,
  aspectRatio = '16/9',
  className = '',
}: IllustrationPlaceholderProps) {
  const aspectClass =
    aspectRatio === '16/9'
      ? 'aspect-[16/9]'
      : aspectRatio === '4/3'
      ? 'aspect-[4/3]'
      : aspectRatio === '21/9'
      ? 'aspect-[21/9]'
      : '';

  return (
    <figure
      id={id}
      className={`my-6 rounded-xl border border-dashed border-sky-500/30 bg-gradient-to-b from-sky-500/[0.03] to-slate-900/[0.04] dark:from-sky-400/[0.04] dark:to-slate-950/40 p-4 sm:p-6 transition-all duration-200 hover:border-sky-500/50 ${className}`}
    >
      <div
        className={`w-full ${aspectClass} min-h-[160px] sm:min-h-[220px] rounded-lg border border-sky-500/20 bg-slate-950/5 dark:bg-slate-900/30 flex flex-col items-center justify-center text-center p-4 sm:p-6 relative overflow-hidden group`}
      >
        {/* Background blueprint decorative grid */}
        <div
          className="absolute inset-0 opacity-[0.07] dark:opacity-[0.12] pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
            backgroundSize: '24px 24px',
          }}
        />

        {/* Center icon badge */}
        <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mb-3 text-sky-600 dark:text-sky-400 shadow-sm transition-transform duration-200 group-hover:scale-105">
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.75"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
            />
          </svg>
        </div>

        {/* Title */}
        <div className="font-medium text-slate-800 dark:text-slate-200 text-sm sm:text-base tracking-tight mb-1 flex items-center gap-2">
          <span>{title}</span>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
            待配图
          </span>
        </div>

        {/* Description */}
        {description && (
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 max-w-md font-normal leading-relaxed">
            {description}
          </p>
        )}

        {/* Footnote hint */}
        <div className="mt-3 text-[11px] font-mono text-slate-400 dark:text-slate-500">
          [ 截图插图占位区 · 待填充实测界面或运行截图 ]
        </div>
      </div>
      <figcaption className="mt-2 text-center text-xs text-slate-400 dark:text-slate-500">
        图示预留：{title}
      </figcaption>
    </figure>
  );
}
