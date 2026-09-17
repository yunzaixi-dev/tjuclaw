import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const withMDX = createMDX({
  mdxOptions: {
    remarkPlugins: [remarkMath],
    rehypePlugins: (v) => [rehypeKatex, ...v],
  },
});
/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  agentRules: false,
  reactStrictMode: true,
  turbopack: {
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
};

export default withMDX(config);
