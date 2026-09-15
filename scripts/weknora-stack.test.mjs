import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureWeKnoraEnv } from './weknora-stack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const compose = readFileSync(join(root, 'ops/weknora/compose.yaml'), 'utf8');
const example = join(root, 'ops/weknora/env.example');

test('WeKnora compose stays on loopback without a Docker socket', () => {
  assert.match(compose, /wechatopenai\/weknora-app:\$\{WEKNORA_VERSION:-v0\.8\.0\}/);
  assert.match(compose, /127\.0\.0\.1:\$\{WEKNORA_APP_HOST_PORT:-18181\}:8080/);
  assert.match(compose, /127\.0\.0\.1:\$\{FRONTEND_PORT:-18180\}:80/);
  assert.match(compose, /WEKNORA_SANDBOX_DOCKER_ENABLED: "false"/);
  assert.match(compose, /internal: true/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:/);
  assert.doesNotMatch(compose, /\/var\/run\/docker/);
});

test('ensureWeKnoraEnv writes secrets once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weknora-env-'));
  try {
    const first = ensureWeKnoraEnv(directory, example);
    const initial = readFileSync(first, 'utf8');
    const password = initial.match(/^DB_PASSWORD=(.+)$/m)[1];
    const aes = initial.match(/^SYSTEM_AES_KEY=(.+)$/m)[1];
    assert.equal(password.length, 64);
    assert.equal(aes.length, 32);
    assert.equal(ensureWeKnoraEnv(directory, example), first);
    assert.equal(readFileSync(first, 'utf8'), initial);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('env example pins a patched WeKnora release', () => {
  const text = readFileSync(example, 'utf8');
  assert.match(text, /^WEKNORA_VERSION=v0\.8\.0$/m);
  assert.match(text, /^WEKNORA_SANDBOX_DOCKER_ENABLED=false$/m);
});
