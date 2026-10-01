import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startSessionTestController } from './session-test-controller.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tjuclaw-session-protocol-'));
  const secret = randomBytes(32).toString('hex');
  const controller = await startSessionTestController(directory, secret);
  const ca = await readFile(controller.certificate);
  t.after(async () => {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  });
  const identity = {
    owner_id: 'isolated-fixture-owner',
    session_id: '1'.repeat(32),
    entry_id: '2'.repeat(32),
    profile: 'study-agent',
  };
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ ...identity, iat: now, exp: now + 60 })).toString('base64url');
  const signed = `v1.${payload}`;
  const token = `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
  const message = { version: 'session.v1', ...identity, turn: 1, content: 'isolated protocol regression' };
  const request = (path, body, authorization = `Bearer ${token}`) => new Promise((resolve, reject) => {
    const req = https.request(new URL(path, controller.url), {
      method: 'POST',
      ca,
      agent: false,
      timeout: 5000,
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('isolated session request timed out')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return { request, message };
}

test('signed cold message needs no separate ensure and retains turn deduplication', async t => {
  const { request, message } = await fixture(t);
  const first = await request('/v1/sessions/message', message);
  assert.equal(first.status, 200);
  assert.equal(first.body.turn, 1);
  assert.equal(first.body.version, 'session.v1');
  const duplicate = await request('/v1/sessions/message', message);
  assert.deepEqual(duplicate, first);
  const conflict = await request('/v1/sessions/message', { ...message, content: 'changed content' });
  assert.equal(conflict.status, 409);
});

test('signed session fixture still rejects invalid authorization, binding and messages', async t => {
  const { request, message } = await fixture(t);
  assert.equal((await request('/v1/sessions/message', message, 'Bearer invalid')).status, 401);
  assert.equal((await request('/v1/sessions/message', { ...message, owner_id: 'different-owner' })).status, 403);
  assert.equal((await request('/v1/sessions/message', { ...message, entry_id: '3'.repeat(32) })).status, 403);
  assert.equal((await request('/v1/sessions/message', { ...message, turn: 0 })).status, 400);
  assert.equal((await request('/v1/sessions/message', { ...message, content: ' ' })).status, 400);
});

test('explicit ensure remains supported by the signed session fixture', async t => {
  const { request, message } = await fixture(t);
  const ensured = await request('/v1/sessions/ensure', message);
  assert.deepEqual(ensured, { status: 200, body: { version: 'session.v1', ready: true } });
  assert.equal((await request('/v1/sessions/message', message)).status, 200);
});
