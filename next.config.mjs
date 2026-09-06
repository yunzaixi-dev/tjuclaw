import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  agentRules: false,
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default withMDX(config);
