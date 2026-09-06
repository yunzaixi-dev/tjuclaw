import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { auditServer, localRequest, pngSize } from '../frontend/audit-server.ts';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('audit requests require local host and same-origin writes', () => {
  assert.equal(localRequest('127.0.0.1:1421', 'http://127.0.0.1:1421'), true);
  assert.equal(localRequest('localhost:1421', undefined), true);
  assert.equal(localRequest('attacker.invalid', undefined), false);
  assert.equal(localRequest('localhost.attacker.invalid', undefined), false);
  assert.equal(localRequest('127.0.0.1:1421', 'https://attacker.invalid'), false);
  assert.deepEqual(pngSize(png), { width: 1, height: 1 });
  assert.throws(() => pngSize(Buffer.from('not PNG')));
});

test('audit API only serves indexed evidence and rejects unsafe uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tjuclaw-audit-'));
  let server;
  try {
    for (const dir of ['reference', 'descriptions', 'runtime']) await mkdir(join(root, dir));
    await writeFile(join(root, 'reference', 'sample.png'), png);
    await writeFile(join(root, 'descriptions', 'GB-000.md'), '# Fixture description');
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      name: 'Test fixture', journeys: [], screens: [{ id: 'GB-000', file: 'sample.png', title: 'Fixture' }],
    }));
    server = await createServer({ configFile: false, root, logLevel: 'silent',
      plugins: [auditServer(root)], server: { host: '127.0.0.1', port: 0, hmr: false } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const get = (path, options) => fetch(`${origin}${path}`, options);
    const manifest = await (await get('/__audit/manifest')).json();
    assert.equal(manifest.screens[0].file, undefined);
    assert.deepEqual(manifest.screens[0].captures, {});
    assert.equal((await get('/__audit/reference/GB-000')).headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await (await get('/__audit/reference/GB-000')).arrayBuffer()), png);
    assert.match(await (await get('/__audit/description/GB-000')).text(), /Fixture description/);
    assert.equal((await get('/__audit/reference/GB-999')).status, 404);
    assert.equal((await get('/__audit/runtime/GB-000/phone')).status, 404);
    assert.equal((await get('/__audit/manifest', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    const endpoint = '/__audit/runtime/GB-000/phone';
    assert.equal((await get(endpoint, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 403);
    const headers = { Origin: origin, 'Content-Type': 'image/png' };
    assert.equal((await get(endpoint, { method: 'POST', headers, body: png })).status, 422);
    assert.equal((await get(endpoint, { method: 'POST', headers, body: 'invalid' })).status, 400);
    await rm(join(root, 'reference', 'sample.png'));
    await symlink(join(tmpdir(), 'outside-evidence-does-not-exist'), join(root, 'reference', 'sample.png'));
    assert.equal((await get('/__audit/reference/GB-000')).status, 404);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
