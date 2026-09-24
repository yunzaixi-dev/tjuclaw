interface CrawlerReportEmbedProps {
  readonly title?: string;
  readonly src?: string;
}

export function CrawlerReportEmbed({
  title = 'TJUClaw V1 爬虫仓库统计报告',
  src = '/reports/crawler-statistics/index.html',
}: CrawlerReportEmbedProps) {
  const iframeMarkup = `<iframe src="${src}" title="${title}" loading="lazy" style="width:100%;min-height:1180px;border:0"></iframe>`;

  return (
    <div suppressHydrationWarning dangerouslySetInnerHTML={{ __html: iframeMarkup }} />
  );
}
