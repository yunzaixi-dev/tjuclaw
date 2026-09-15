import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { listeningPids, ownsProcess } from './dev-ports.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('only this checkout Vite and exact development API executable are owned', () => {
  const web = { cwd: resolve(root, 'frontend'), exe: '/usr/bin/node', argv: ['node', resolve(root, 'frontend/node_modules/.bin/../vite/bin/vite.js')] };
  assert.equal(ownsProcess(web, 'web'), true);
  assert.equal(ownsProcess({ ...web, argv: ['node', resolve(root, 'frontend/node_modules/.pnpm/vite@8.2.2/node_modules/vite/bin/vite.js')] }, 'web'), true);
  assert.equal(ownsProcess({ ...web, argv: ['node', 'unrelated.mjs'] }, 'web'), false);
  assert.equal(ownsProcess({ ...web, cwd: '/another-checkout/frontend' }, 'web'), false);
  const api = { cwd: resolve(root, 'ops/local/auth-dev'), exe: resolve(root, 'ops/local/auth-dev/tjuclaw-api'), argv: [] };
  assert.equal(ownsProcess(api, 'api'), true);
  assert.equal(ownsProcess({ ...api, exe: '/another-checkout/tjuclaw-api' }, 'api'), false);
  assert.equal(ownsProcess({ ...api, cwd: '/another-checkout' }, 'api'), false);
  const airApi = { cwd: resolve(root, 'backend'), exe: resolve(root, 'backend/tmp/api'), argv: [] };
  assert.equal(ownsProcess(airApi, 'api'), true);
  assert.equal(ownsProcess({ cwd: resolve(root, 'backend'), exe: '/usr/bin/go', argv: ['go', 'run', 'github.com/air-verse/air@v1.67.4', '-c', '.air.toml'] }, 'api'), true);
  assert.equal(ownsProcess({ ...airApi, cwd: '/another-checkout/backend' }, 'api'), false);
  const docs = { cwd: resolve(root, 'docs'), exe: '/usr/bin/node', argv: ['node', './node_modules/.bin/../next/dist/bin/next', 'dev', '--port', '3000'] };
  assert.equal(ownsProcess(docs, 'docs'), true);
  assert.equal(ownsProcess({ ...docs, argv: ['next-server (v16.3.4)'] }, 'docs'), true);
  assert.equal(ownsProcess({ ...docs, cwd: '/another-checkout/docs' }, 'docs'), false);


});

test('listener discovery returns the actual socket owner', { skip: process.platform !== 'linux' }, async () => {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { assert.ok(listeningPids(server.address().port).includes(process.pid)); }
  finally { await new Promise(done => server.close(done)); }
});

test('listener discovery ignores IPv6-only occupants', { skip: process.platform !== 'linux' }, async () => {
  const server = createServer();
  await new Promise(done => server.listen(0, '::1', done));
  try { assert.equal(listeningPids(server.address().port).includes(process.pid), false); }
  finally { await new Promise(done => server.close(done)); }
});
