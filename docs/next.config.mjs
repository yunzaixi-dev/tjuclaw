import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  agentRules: false,
  reactStrictMode: true,
  async rewrites() {
    if (process.env.NODE_ENV === 'development') return [];
    return {
      afterFiles: [{ source: '/presentation/:path*', destination: '/presentation/index.html' }],
    };
  },
  turbopack: {
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
};

export default withMDX(config);
