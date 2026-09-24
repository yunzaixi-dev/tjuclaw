import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncApiDocs } from './sync-api-docs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = path.join(repoRoot, 'docs/content/openapi/tjuclaw.yaml');

test('OpenAPI source and Fumadocs copy are synchronized', () => {
  const result = syncApiDocs({ check: true });
  assert.equal(result.changed, false);
  assert.ok(fs.existsSync(targetPath));
});

test('OpenAPI documents campus routes implemented by the Go API', () => {
  const document = fs.readFileSync(targetPath, 'utf8');
  for (const route of [
    '/campus/session:',
    '/campus/semester:',
    '/campus/classes:',
    '/campus/entry-code:',
    '/campus/studyroom/campuses:',
    '/campus/forum/posts:',
  ]) {
    assert.match(document, new RegExp(`\\n  ${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});
