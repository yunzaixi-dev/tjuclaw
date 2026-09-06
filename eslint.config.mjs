import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', 'private/**', 'research/**', 'docs/**', 'frontend/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
];
