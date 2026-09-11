import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  agentRules: false,
  reactStrictMode: true,
  turbopack: {
    root: fileURLToPath(new URL('..', import.meta.url)),
  },
};

export default withMDX(config);
