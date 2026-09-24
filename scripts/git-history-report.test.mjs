import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPath,
  parseNumstat,
  scoreCommit,
} from './git-history-report.mjs';

test('classifies tracked paths into code, config, docs and other', () => {
  assert.equal(classifyPath('frontend/src/main.tsx'), 'code');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'config');
  assert.equal(classifyPath('docs/content/docs/README.md'), 'docs');
  assert.equal(classifyPath('screenshots/demo.png'), 'other');
});

test('parses text numstat and ignores binary changes', () => {
  const stats = parseNumstat([
    '12\t3\tfrontend/src/main.tsx',
    '4\t0\tREADME.md',
    '-\t-\tassets/logo.png',
    '8\t2\told.ts => new.ts',
  ].join('\n'));

  assert.deepEqual(stats, [
    { path: 'frontend/src/main.tsx', added: 12, deleted: 3, category: 'code' },
    { path: 'README.md', added: 4, deleted: 0, category: 'docs' },
    { path: 'old.ts => new.ts', added: 8, deleted: 2, category: 'code' },
  ]);
});

test('marks feature commits with product keywords as key commits', () => {
  const result = scoreCommit({
    subject: '✨ [v0.0.1] feat(auth): enable Kratos workspace login',
    stats: {
      all: { added: 100, deleted: 10 },
      code: { added: 100, deleted: 10 },
    },
    topLevelPaths: ['backend', 'frontend'],
  }, false, false, 7);

  assert.equal(result.type, 'feat');
  assert.equal(result.version, '0.0.1');
  assert.equal(result.isKey, true);
  assert.deepEqual(result.keyReason, ['feat', 'auth', 'workspace']);
});
