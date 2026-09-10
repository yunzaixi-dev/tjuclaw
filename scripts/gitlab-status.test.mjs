import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapGitHubToGitLabStatus,
  validateSha,
  validateGitLabUrl,
  validateGitHubApiUrl,
  resolveStatusContext,
  isRunSuperseded,
  sanitizeErrorMessage,
  syncGitLabStatus,
  STATUS_CONTEXT_CI,
  STATUS_CONTEXT_WINDOWS,
} from './gitlab-status.mjs';

test('mapGitHubToGitLabStatus maps GitHub queued/in_progress/completed to GitLab states', () => {
  assert.equal(mapGitHubToGitLabStatus('queued', null), 'pending');
  assert.equal(mapGitHubToGitLabStatus('in_progress', null), 'running');
  assert.equal(mapGitHubToGitLabStatus('completed', 'success'), 'success');
  assert.equal(mapGitHubToGitLabStatus('completed', 'failure'), 'failed');
  assert.equal(mapGitHubToGitLabStatus('completed', 'timed_out'), 'failed');
  assert.equal(mapGitHubToGitLabStatus('completed', 'action_required'), 'failed');
  assert.equal(mapGitHubToGitLabStatus('completed', 'cancelled'), 'canceled');
  assert.equal(mapGitHubToGitLabStatus('completed', 'skipped'), 'skipped');
  assert.equal(mapGitHubToGitLabStatus('completed', 'neutral'), 'skipped');
  assert.equal(mapGitHubToGitLabStatus('unknown', null), 'pending');
});

test('validateSha enforces strict 40-character hexadecimal strings', () => {
  const validSha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(validateSha(validSha), validSha);

  const invalids = [
    '',
    '0123456789abcdef',
    '0123456789abcdef0123456789abcdef0123456G',
    '0123456789ABCDEF0123456789abcdef01234567', // uppercase rejected
    '../test',
    '0123456789abcdef0123456789abcdef01234567\n',
  ];
  for (const inv of invalids) {
    assert.throws(() => validateSha(inv), /Invalid SHA/);
  }
});

test('validateGitLabUrl allows only https://gitlab.tju.edu.cn', () => {
  assert.equal(validateGitLabUrl('https://gitlab.tju.edu.cn'), 'https://gitlab.tju.edu.cn');
  assert.equal(validateGitLabUrl('https://gitlab.tju.edu.cn/'), 'https://gitlab.tju.edu.cn');
  assert.equal(validateGitLabUrl(), 'https://gitlab.tju.edu.cn');

  const invalidUrls = [
    'http://gitlab.tju.edu.cn',
    'https://attacker.com',
    'https://gitlab.com',
    'ftp://gitlab.tju.edu.cn',
  ];
  for (const u of invalidUrls) {
    assert.throws(() => validateGitLabUrl(u));
  }
});

test('validateGitHubApiUrl allows only https://api.github.com', () => {
  assert.equal(validateGitHubApiUrl('https://api.github.com'), 'https://api.github.com');
  assert.equal(validateGitHubApiUrl(), 'https://api.github.com');

  const invalidUrls = [
    'http://api.github.com',
    'https://evil.github.com',
    'https://api.github.com.evil.com',
  ];
  for (const u of invalidUrls) {
    assert.throws(() => validateGitHubApiUrl(u));
  }
});

test('resolveStatusContext maps CI and Windows Installer workflows correctly', () => {
  assert.equal(resolveStatusContext('CI'), STATUS_CONTEXT_CI);
  assert.equal(resolveStatusContext('Windows Installer'), STATUS_CONTEXT_WINDOWS);
  assert.throws(() => resolveStatusContext('Other Workflow'), /Unsupported workflow name/);
});

test('isRunSuperseded detects newer runs for the same workflow and SHA', () => {
  const currentRun = { id: 100, created_at: '2026-09-09T01:00:00Z' };
  const olderRun = { id: 99, created_at: '2026-09-09T00:50:00Z' };
  const newerRun = { id: 101, created_at: '2026-09-09T01:10:00Z' };

  assert.equal(isRunSuperseded([olderRun, currentRun], 100), false);
  assert.equal(isRunSuperseded([olderRun, currentRun, newerRun], 100), true);
  assert.equal(isRunSuperseded([], 100), false);
  assert.equal(isRunSuperseded([newerRun], 100), true);
});

test('sanitizeErrorMessage strips tokens and secrets from errors', () => {
  const secret = 'glpat-SECRET1234567890abcdef';
  const ghSecret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  const err = new Error(`Connection failed with token ${secret} and ${ghSecret}`);
  const sanitized = sanitizeErrorMessage(err, [secret, ghSecret]);

  assert.ok(!sanitized.includes('SECRET1234567890abcdef'));
  assert.ok(!sanitized.includes('abcdefghijklmnopqrstuvwxyz123456'));
  assert.ok(sanitized.includes('[REDACTED]'));
});

test('syncGitLabStatus fails when enabled without its credential', async () => {
  await assert.rejects(syncGitLabStatus({}), /GITLAB_STATUS_TOKEN/);
});

test('syncGitLabStatus validates required environment variables when token is present', async () => {
  await assert.rejects(
    async () => {
      await syncGitLabStatus({ GITLAB_STATUS_TOKEN: 'glpat-dummy' });
    },
    /GITHUB_TOKEN/
  );

  await assert.rejects(
    async () => {
      await syncGitLabStatus({
        GITLAB_STATUS_TOKEN: 'glpat-dummy',
        GITHUB_TOKEN: 'ghp_dummy',
      });
    },
    /GITHUB_REPOSITORY/
  );

  await assert.rejects(
    async () => {
      await syncGitLabStatus({
        GITLAB_STATUS_TOKEN: 'glpat-dummy',
        GITHUB_TOKEN: 'ghp_dummy',
        GITHUB_REPOSITORY: 'yunzaixi-dev/tjuclaw',
      });
    },
    /TARGET_RUN_ID/
  );
});

test('syncGitLabStatus full mocked flow succeeds and posts correct payload', async () => {
  const originalFetch = globalThis.fetch;
  const recordedRequests = [];

  const validSha = '0123456789abcdef0123456789abcdef01234567';

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    recordedRequests.push({ url: String(url), method: options.method || 'GET', headers: options.headers, body: options.body });

    // GitHub run get
    if (String(url).endsWith('/actions/runs/12345')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 12345,
          name: 'CI',
          event: 'push',
          head_branch: 'release',
          head_sha: validSha,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/yunzaixi-dev/tjuclaw/actions/runs/12345',
          workflow_id: 999,
          repository: { full_name: 'yunzaixi-dev/tjuclaw' },
          head_repository: { full_name: 'yunzaixi-dev/tjuclaw' },
        }),
      };
    }

    // GitHub runs list for workflow
    if (String(url).includes('/actions/workflows/999/runs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow_runs: [
            { id: 12345, created_at: '2026-09-09T01:00:00Z' }
          ]
        }),
      };
    }

    // GitLab commit lookup
    if (String(url).includes(`/repository/commits/${validSha}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: validSha,
        }),
      };
    }

    // GitLab commit status POST
    if (String(url).includes(`/statuses/${validSha}`)) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 1,
          sha: validSha,
          status: 'success',
        }),
      };
    }

    return {
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not found' }),
    };
  };

  try {
    const res = await syncGitLabStatus({
      GITLAB_STATUS_TOKEN: 'glpat-test-token',
      GITHUB_TOKEN: 'ghp_test_token',
      GITHUB_REPOSITORY: 'yunzaixi-dev/tjuclaw',
      TARGET_RUN_ID: '12345',
      GITLAB_URL: 'https://gitlab.tju.edu.cn',
      GITLAB_PROJECT_ID: '145',
    });

    assert.equal(res.success, true);
    assert.equal(res.sha, validSha);
    assert.equal(res.context, STATUS_CONTEXT_CI);
    assert.equal(res.state, 'success');

    // Check recorded requests
    const postReq = recordedRequests.find(r => r.method === 'POST');
    assert.ok(postReq);
    assert.equal(postReq.headers['PRIVATE-TOKEN'], 'glpat-test-token');
    const postBody = JSON.parse(postReq.body);
    assert.equal(postBody.state, 'success');
    assert.equal(postBody.ref, 'release');
    assert.equal(postBody.name, STATUS_CONTEXT_CI);
    assert.equal(postBody.context, STATUS_CONTEXT_CI);
    assert.equal(postBody.target_url, 'https://github.com/yunzaixi-dev/tjuclaw/actions/runs/12345');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
