import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkMessage, isPrivatePath } from './git-policy.mjs';

test('commit titles require a matching emoji, type, and version', () => {
  const valid = [
    '\u{1F527} [v0.0.25] chore(repo): establish conventions',
    '\u2728 [v0.0.25] feat(frontend)!: update navigation\n\nMigration notes.',
    '\u267B\uFE0F [v0.0.25] refactor: simplify code',
  ];
  for (const message of valid) assert.doesNotThrow(() => checkMessage(message, '0.0.25'));
  const invalid = [
    'chore: no emoji or version', ':sparkles: [v0.0.25] feat: not an emoji',
    '\u2728 [v0.0.25] fix: mismatched emoji', '\u{1F527} [v0.0.26] chore: wrong version',
    '\u{1F527} [v0.0.25] chore: ', '\u{1F527} [v0.0.25] chore: trailing ',
    `\u{1F527} [v0.0.25] chore: ${'x'.repeat(100)}`, 'Merge branch topic',
    'fixup! \u{1F527} [v0.0.25] chore: temporary',
  ];
  for (const message of invalid) assert.throws(() => checkMessage(message, '0.0.25'));
  assert.doesNotThrow(() => checkMessage('\u{1F680} [v0.1.0-rc.0] build: candidate', '0.1.0-rc.0'));
  for (const version of ['01.0.0', '0.1', '1.0.0-rc.01', '1.0.0+build', undefined]) {
    assert.throws(() => checkMessage('', version));
  }
});

test('private paths are blocked while safe templates and source remain allowed', () => {
  for (const path of [
    'CONTEXT.md', 'KEY_LINKS.md', 'research/data.json', 'private/note.md',
    'public/ui-reference/image.png', 'content/docs/06-ui-reference.mdx',
    '.env', 'frontend/.env.local', 'a.private.md', 'key.pem', 'key.key',
    'ops/local/cluster.yaml', 'state.tfstate.backup', 'ops/.terraform/state',
    'ops/kubeconfig', 'ops/talosconfig',
    'content/docs/07-intelligence.mdx', 'content/docs/01-architecture.mdx',
    'ops/container-inventory.md', 'mobbin_screens.zip',
    'scripts/clone-gitlab-intelligence.mjs', 'scripts/collect-public-tju-data.mjs',
    'data/accounts.sqlite', 'data/users.db', 'backup.sql.gz',
  ]) assert.equal(isPrivatePath(path), true, path);
  for (const path of ['.env.example', 'backend/.env.dev.example', 'src/app/page.tsx', 'CONTRIBUTING.md']) {
    assert.equal(isPrivatePath(path), false, path);
  }
});

test('real hooks reject bad commits and forced private staging without touching this repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-git-policy-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  // Isolate the fixture even when these tests are invoked from a Git hook.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key];
  }
  const run = (args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  const commit = (message) => spawnSync('git', ['commit', '-m', message], { cwd: root, env, encoding: 'utf8' });
  try {
    run(['init', '-b', 'main']);
    run(['config', 'user.name', 'Policy Test']);
    run(['config', 'user.email', 'policy@example.invalid']);
    for (const dir of ['scripts', '.githooks']) mkdirSync(join(root, dir));
    for (const path of ['scripts/git-policy.mjs', 'scripts/setup-git.mjs', '.githooks/pre-commit', '.githooks/commit-msg']) {
      copyFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), join(root, path));
    }
    execFileSync(process.execPath, ['scripts/setup-git.mjs'], { cwd: root, env });
    writeFileSync(join(root, 'package.json'), '{"version":"0.0.25"}\n');
    run(['add', 'package.json', 'scripts', '.githooks']);
    writeFileSync(join(root, 'package.json'), '{"version":"0.0.26"}\n');
    assert.notEqual(commit('\u{1F527} [v0.0.26] chore: wrong staged version').status, 0);
    const first = commit('\u{1F527} [v0.0.25] chore: initial');
    assert.equal(first.status, 0, first.stderr);
    run(['add', 'package.json']);
    assert.notEqual(commit('bad title').status, 0);
    mkdirSync(join(root, 'research'));
    writeFileSync(join(root, 'research', 'private.md'), 'private fixture\n');
    writeFileSync(join(root, '.gitignore'), '/research/\n');
    run(['add', '.gitignore']);
    run(['add', '-f', 'research/private.md']);
    const blocked = commit('\u{1F527} [v0.0.26] chore: should fail');
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Private paths/);
    run(['rm', '--cached', 'research/private.md']);
    const clean = commit('\u{1F527} [v0.0.26] chore: next version');
    assert.equal(clean.status, 0, clean.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
