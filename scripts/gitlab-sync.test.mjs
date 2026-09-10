import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncSource, validateMirrorRef, mirrorUrl } from './gitlab-sync.mjs';

const sha = 'a'.repeat(40);
const env = { GITHUB_REPOSITORY: 'yunzaixi-dev/tjuclaw', GITHUB_SHA: sha,
  GITHUB_REF: 'refs/heads/release', GITLAB_SYNC_TOKEN: 'fake-test-token' };

test('mirror accepts only release and selected version tags', () => {
  assert.equal(validateMirrorRef('refs/tags/v0.0.25'), 'refs/tags/v0.0.25');
  assert.equal(validateMirrorRef('refs/heads/release'), 'refs/heads/release');
  for (const ref of ['refs/heads/main', 'refs/heads/feature', '--mirror', 'refs/tags/other', '', undefined]) {
    assert.throws(() => validateMirrorRef(ref));
  }
});

test('source synchronization preserves annotated ref objects without force or credential URLs', () => {
  const calls = [];
  const object = 'b'.repeat(40);
  const result = syncSource(env, (command, args, options) => {
    calls.push({ command, args, options });
    if (args.join(' ') === 'rev-parse HEAD') return sha;
    if (args[0] === 'rev-parse') return object;
    return '';
  });
  assert.equal(result.source, sha);
  const args = calls.at(-1).args;
  assert.ok(args.includes('--atomic'));
  assert.ok(args.includes(mirrorUrl));
  assert.equal(args.at(-1), `${object}:refs/heads/release`);
  assert.ok(!args.some(value => /fake-test-token|--force|--mirror/.test(value)));
});

test('mirror rejects incorrect checkout or repository before pushing', () => {
  assert.throws(() => syncSource({ ...env, GITHUB_REPOSITORY: 'other/repo' }));
  assert.throws(() => syncSource({ ...env, GITLAB_SYNC_TOKEN: '' }));
  assert.throws(() => syncSource(env, () => 'c'.repeat(40)), /Checkout/);
});

test('credential helper refuses unrelated hosts and repository paths', () => {
  const helper = fileURLToPath(new URL('./gitlab-credential.mjs', import.meta.url));
  const request = path => spawnSync(process.execPath, [helper, 'get'], {
    input: `protocol=https\nhost=gitlab.tju.edu.cn\npath=${path}\n\n`,
    encoding: 'utf8', env: { GITLAB_SYNC_TOKEN: 'fake-test-token' },
  }).stdout;
  assert.equal(request('another/project.git'), '');
  assert.match(request('3023244020/agent2026-tjuclaw.git'), /password=fake-test-token/);
  assert.equal(spawnSync(process.execPath, [helper, 'get'], { input: 'protocol=https\nhost=evil.test\n',
    encoding: 'utf8', env: { GITLAB_SYNC_TOKEN: 'fake-test-token' } }).stdout, '');
});
