import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = defineConfig([
  ...nextVitals,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    '.source/**',
    'research/**',
    'private/**',
    'frontend/**',
    'backend/**',
    'ops/**',
    'research/intelligence/**',
  ]),
]);

export default eslintConfig;
