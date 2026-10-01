import assert from 'node:assert/strict';
import test from 'node:test';
import { changedFiles, groups, plan } from './ci-plan.mjs';

const selected = files => groups.filter(group => plan(files)[group]);

test('each change selects only the jobs that read it', () => {
  assert.deepEqual(selected([]), []);
  assert.deepEqual(selected(['docs/content/docs/index.md', 'README.md', 'DESIGN.md']), ['docs']);
  assert.deepEqual(selected(['frontend']), ['web', 'integration']);
  assert.deepEqual(selected(['backend']), ['api', 'integration']);
  assert.deepEqual(selected(['cli']), ['cli', 'sandbox']);
  assert.deepEqual(selected(['crawler']), ['crawler']);
  assert.deepEqual(selected(['sandbox']), ['sandbox']);
  assert.deepEqual(selected(['ops/ansible/roles/api/tasks/main.yml']), ['ops']);
  assert.deepEqual(selected(['scripts/deploy-release.mjs']), ['ops']);
  assert.deepEqual(selected(['ops/auth/compose.yaml']), ['api', 'ops', 'integration']);
  assert.deepEqual(selected(['ops/images/nginx.conf']), ['api', 'ops', 'integration']);
  assert.deepEqual(selected(['scripts/auth.spec.mjs']), ['integration']);
  assert.deepEqual(selected(['compose.yaml']), ['integration']);
  assert.deepEqual(selected(['scripts/sync-api-docs.mjs']), ['web', 'docs', 'api', 'cli', 'crawler']);
  assert.deepEqual(selected(['frontend', 'docs/content/docs/guide.md']), ['web', 'docs', 'integration']);
});

test('shared build inputs and unknown paths run everything', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', 'Taskfile.yml',
    'package.json', 'pnpm-lock.yaml', '.gitmodules', 'brand-new-directory/file']) {
    assert.deepEqual(selected(['docs/content/docs/index.md', file]), groups, file);
  }
  assert.deepEqual(selected(null), groups);
});

test('pushes compare with the last successful run and fall back to a full run', async () => {
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'refs/heads/release',
    GITHUB_REF_NAME: 'release', GITHUB_SHA: 'head', GITHUB_RUN_ATTEMPT: '1' };
  const calls = [];
  const request = responses => async path => { calls.push(path); return responses.shift(); };
  assert.deepEqual(await changedFiles(env, request([
    { workflow_runs: [{ head_sha: 'good' }] },
    { files: [{ filename: 'frontend' }, { filename: 'docs/new.md', previous_filename: 'ops/old.md' }] },
  ])), ['frontend', 'docs/new.md', 'ops/old.md']);
  assert.deepEqual(calls, [
    '/repos/owner/repo/actions/workflows/ci.yml/runs?branch=release&status=success&per_page=1',
    '/repos/owner/repo/compare/good...head',
  ]);

  assert.equal(await changedFiles(env, request([{ workflow_runs: [] }])), null);
  assert.equal(await changedFiles(env, request([{ workflow_runs: [{ head_sha: 'good' }] }, { files: Array(300).fill({ filename: 'docs/a.md' }) }])), null);
  assert.equal(await changedFiles(env, request([{ workflow_runs: [{ head_sha: 'good' }] }, {}])), null);
  const never = async () => { throw new Error('must not call the API'); };
  assert.equal(await changedFiles({ ...env, GITHUB_RUN_ATTEMPT: '2' }, never), null);
  assert.equal(await changedFiles({ ...env, GITHUB_REF: 'refs/tags/v1.0.0' }, never), null);
  assert.equal(await changedFiles({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, never), null);
});

test('pull requests compare their head with the base branch', async () => {
  const calls = [];
  const files = await changedFiles({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_REF: 'refs/pull/7/merge', GITHUB_SHA: 'merge', BASE_SHA: 'base', HEAD_SHA: 'tip', GITHUB_RUN_ATTEMPT: '1' },
  async path => { calls.push(path); return { files: [{ filename: 'crawler' }] }; });
  assert.deepEqual(files, ['crawler']);
  assert.deepEqual(calls, ['/repos/owner/repo/compare/base...tip']);
});
