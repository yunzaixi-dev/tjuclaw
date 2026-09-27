import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { implementedRoutes, routesInGoSource, syncApiDocs, validate } from './sync-api-docs.mjs';

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

test('OpenAPI route scan includes auth handler maps without treating arbitrary strings as routes', () => {
  const fixture = `
    for path, handler := range map[string]http.HandlerFunc{
      "POST /auth/new/{id}": h.new, "GET /auth/flow": h.flow,
    } {
      mux.HandleFunc(path, handler)
    }
    msg := "POST /not-a-route"
    mux.HandleFunc("DELETE /vault/objects/{id}", h.remove)
  `;
  assert.deepEqual([...routesInGoSource(fixture)].sort(), [
    'DELETE /vault/objects/{id}', 'GET /auth/flow', 'POST /auth/new/{id}',
  ]);
  const registered = implementedRoutes();
  for (const route of ['GET /auth/flow', 'POST /auth/start', 'POST /auth/password']) {
    assert.ok(registered.has(route), `missing ${route}`);
  }
});

test('OpenAPI check rejects an undocumented map-registered authentication endpoint', () => {
  const document = parse(fs.readFileSync(path.join(repoRoot, 'backend/openapi/tjuclaw.yaml'), 'utf8'));
  delete document.paths['/auth/password'].post;
  assert.throws(() => validate(document), /POST \/auth\/password/);
});
