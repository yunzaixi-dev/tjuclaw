import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', 'private/**', 'research/**', 'docs/**', 'frontend/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  { files: ['scripts/ui.spec.mjs', 'scripts/auth.spec.mjs', 'scripts/workspace.spec.mjs', 'scripts/audit-ui.spec.mjs'], languageOptions: { globals: globals.browser } },
];
