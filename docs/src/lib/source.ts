import { fileURLToPath, URL as NodeURL } from 'node:url';
import { loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { docsContentRoute, docsImageRoute, docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

const openapi = createOpenAPI({
  input: {
    tjuclaw: fileURLToPath(new NodeURL('../../content/openapi/tjuclaw.yaml', import.meta.url)),
  },
});

const openapiSource = await openapi.staticSource({
  baseDir: 'api-reference/reference',
  per: 'operation',
  groupBy: 'tag',
  meta: true,
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: {
    docs: docs.toFumadocsSource(),
    api: openapiSource,
  },
  plugins: [lucideIconsPlugin(), openapi.loaderPlugin()],
});

export function getPageImageUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: '/' + [page.locale, ...docsImageRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  if ('getOpenAPIPageProps' in page.data) {
    const props = page.data.getOpenAPIPageProps();
    const operations = [...(props.operations ?? []), ...(props.webhooks ?? [])]
      .map((item) => `${item.method.toUpperCase()} ${'path' in item ? item.path : item.name}`)
      .join('\n');

    return `# ${page.data.title} (${page.url})

${page.data.description ?? ''}

${operations}`;
  }

  const processed = await page.data.getText('processed');

  return `# ${page.data.title} (${page.url})

${processed}`;
}
