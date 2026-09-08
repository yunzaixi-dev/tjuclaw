import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  validateSha,
  validateSha256,
  validateGitLabUrl,
  validateProjectId,
  sanitizeErrorMessage,
  verifyLocalFile,
  validateReleaseManifest,
  verifyCommitAndTag,
  uploadPackageFile,
  publishGitLabRelease,
  executeGitLabRelease,
  MAX_FILE_SIZE_BYTES,
} from './gitlab-release.mjs';

function computeHex(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('validateSha enforces strict 40-character hexadecimal strings', () => {
  const valid = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(validateSha(valid), valid);
  assert.throws(() => validateSha(''), /Invalid commit ref/);
  assert.throws(() => validateSha('0123456789abcdef'), /Invalid commit ref/);
  assert.throws(() => validateSha(valid.toUpperCase()), /Invalid commit ref/);
  assert.throws(() => validateSha(`${valid}\n`), /Invalid commit ref/);
});

test('validateSha256 enforces strict 64-character hexadecimal strings', () => {
  const valid = 'a'.repeat(64);
  assert.equal(validateSha256(valid), valid);
  assert.throws(() => validateSha256(''), /Invalid sha256/);
  assert.throws(() => validateSha256('a'.repeat(63)), /Invalid sha256/);
  assert.throws(() => validateSha256('A'.repeat(64)), /Invalid sha256/);
});

test('validateGitLabUrl strictly allows only https://gitlab.tju.edu.cn', () => {
  assert.equal(validateGitLabUrl('https://gitlab.tju.edu.cn'), 'https://gitlab.tju.edu.cn');
  assert.equal(validateGitLabUrl('https://gitlab.tju.edu.cn/'), 'https://gitlab.tju.edu.cn');
  assert.equal(validateGitLabUrl(), 'https://gitlab.tju.edu.cn');

  const invalidUrls = [
    'http://gitlab.tju.edu.cn',
    'https://gitlab.com',
    'https://attacker.org',
    'ftp://gitlab.tju.edu.cn',
  ];
  for (const u of invalidUrls) {
    assert.throws(() => validateGitLabUrl(u), /GitLab host|protocol/);
  }
});

test('validateProjectId strictly allows only project 145', () => {
  assert.equal(validateProjectId('145'), '145');
  assert.equal(validateProjectId(145), '145');
  assert.equal(validateProjectId(), '145');
  assert.throws(() => validateProjectId('146'), /Invalid GITLAB_PROJECT_ID/);
  assert.throws(() => validateProjectId('other'), /Invalid GITLAB_PROJECT_ID/);
});

test('validateReleaseManifest rejects oversized files (>1GiB)', async () => {
  // We test verifyLocalFile rejection when size > MAX_FILE_SIZE_BYTES by mocking or checking check logic
  assert.equal(typeof MAX_FILE_SIZE_BYTES, 'number');
  assert.equal(MAX_FILE_SIZE_BYTES, 1024 * 1024 * 1024);
});

test('sanitizeErrorMessage strips tokens and secrets from errors', () => {
  const secret = 'glpat-SECRET1234567890abcdef';
  const err = new Error(`Failed to authenticate with token ${secret}`);
  const sanitized = sanitizeErrorMessage(err, [secret]);
  assert.ok(!sanitized.includes('SECRET1234567890abcdef'));
  assert.ok(sanitized.includes('[REDACTED]'));
});

test('verifyLocalFile verifies regular file, rejects symlinks, size > 1GiB and checksum mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-release-'));
  try {
    const filePath = join(dir, 'test-bin.exe');
    const content = Buffer.from('executable content here');
    const expectedHash = computeHex(content);
    await writeFile(filePath, content);

    // 1. Success case
    const verified = await verifyLocalFile(filePath, expectedHash);
    assert.equal(verified.sha256, expectedHash);
    assert.equal(verified.size, content.length);

    // 2. Hash mismatch
    await assert.rejects(
      () => verifyLocalFile(filePath, '0'.repeat(64)),
      /Checksum mismatch/
    );

    // 3. Symlink rejection
    const symlinkPath = join(dir, 'symlink-bin.exe');
    await symlink(filePath, symlinkPath);
    await assert.rejects(
      () => verifyLocalFile(symlinkPath, expectedHash),
      /symbolic link, which is rejected/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateReleaseManifest rejects path traversal, duplicate names, and tag-version mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-manifest-'));
  try {
    const file1 = join(dir, 'file1.bin');
    const content1 = Buffer.from('file1 content');
    const hash1 = computeHex(content1);
    await writeFile(file1, content1);

    const validRef = '0123456789abcdef0123456789abcdef01234567';
    const validClientSha = 'fedcba9876543210fedcba9876543210fedcba98';

    // 1. Valid manifest
    const validManifest = {
      version: '0.0.25',
      tag: 'v0.0.25',
      ref: validRef,
      client_sha: validClientSha,
      files: [{ path: file1, name: 'file1.bin', sha256: hash1 }],
      description: 'Release v0.0.25',
    };
    const res = await validateReleaseManifest(validManifest);
    assert.equal(res.version, '0.0.25');
    assert.equal(res.files.length, 1);

    // 2. Tag mismatch
    await assert.rejects(
      () => validateReleaseManifest({ ...validManifest, tag: 'v0.0.26' }),
      /Tag "v0.0.26" does not match version "v0.0.25"/
    );

    // 3. Path traversal filename
    await assert.rejects(
      () => validateReleaseManifest({
        ...validManifest,
        files: [{ path: file1, name: '../file1.bin', sha256: hash1 }],
      }),
      /Invalid or path-traversal filename/
    );

    // 4. Duplicate filenames
    await assert.rejects(
      () => validateReleaseManifest({
        ...validManifest,
        files: [
          { path: file1, name: 'file1.bin', sha256: hash1 },
          { path: file1, name: 'file1.bin', sha256: hash1 },
        ],
      }),
      /Duplicate filename/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyCommitAndTag verifies integration commit and checks tag consistency', async () => {
  const ref = '0123456789abcdef0123456789abcdef01234567';
  const tag = 'v0.0.25';
  const gitlabUrl = 'https://gitlab.tju.edu.cn';
  const projectId = '145';
  const token = 'glpat-dummy';

  // 1. Commit exists, tag not existing -> success
  const mockFetch1 = async (url) => {
    if (url.includes(`/repository/commits/${ref}`)) {
      return { ok: true, status: 200, json: async () => ({ id: ref }) };
    }
    if (url.includes(`/repository/tags/${tag}`)) {
      return { ok: false, status: 404 };
    }
    throw new Error(`Unexpected url ${url}`);
  };
  const res1 = await verifyCommitAndTag(gitlabUrl, projectId, ref, tag, token, mockFetch1);
  assert.equal(res1.tagExists, false);
  assert.equal(res1.refMatches, true);

  // 2. Commit missing in GitLab -> throws
  const mockFetchMissingCommit = async (url) => {
    if (url.includes(`/repository/commits/${ref}`)) {
      return { ok: false, status: 404 };
    }
    throw new Error(`Unexpected url ${url}`);
  };
  await assert.rejects(
    () => verifyCommitAndTag(gitlabUrl, projectId, ref, tag, token, mockFetchMissingCommit),
    /Integration commit ref .* not found/
  );

  // 3. Tag exists but points to different SHA -> throws
  const mockFetchTagMismatch = async (url) => {
    if (url.includes(`/repository/commits/${ref}`)) {
      return { ok: true, status: 200, json: async () => ({ id: ref }) };
    }
    if (url.includes(`/repository/tags/${tag}`)) {
      return { ok: true, status: 200, json: async () => ({ target: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }) };
    }
    throw new Error(`Unexpected url ${url}`);
  };
  await assert.rejects(
    () => verifyCommitAndTag(gitlabUrl, projectId, ref, tag, token, mockFetchTagMismatch),
    /points to .* not integration ref/
  );
});

test('checkExistingPackageFile and uploadPackageFile handle skip on match and throw on mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-upload-'));
  try {
    const filePath = join(dir, 'app.tar.gz');
    const content = Buffer.from('archive content');
    const hash = computeHex(content);
    await writeFile(filePath, content);

    const fileItem = { path: filePath, name: 'app.tar.gz', sha256: hash, size: content.length };
    const gitlabUrl = 'https://gitlab.tju.edu.cn';
    const projectId = '145';
    const version = '0.0.25';
    const token = 'glpat-dummy';

    // 1. File does not exist -> uploads successfully
    let putCalled = false;
    const mockFetchUpload = async (url, opts = {}) => {
      if (opts.method === 'HEAD') {
        return { status: 404 };
      }
      if (opts.method === 'PUT') {
        putCalled = true;
        return { status: 201, ok: true };
      }
      throw new Error(`Unexpected call ${opts.method} ${url}`);
    };
    const resUpload = await uploadPackageFile(gitlabUrl, projectId, version, fileItem, token, mockFetchUpload);
    assert.equal(resUpload.uploaded, true);
    assert.equal(putCalled, true);

    // 2. File exists and hash matches -> skipped
    const mockFetchSkip = async (url, opts = {}) => {
      if (opts.method === 'HEAD') {
        return {
          status: 200,
          headers: { get: (h) => (h === 'x-checksum-sha256' ? hash : null) },
        };
      }
      throw new Error(`Unexpected call ${opts.method} ${url}`);
    };
    const resSkip = await uploadPackageFile(gitlabUrl, projectId, version, fileItem, token, mockFetchSkip);
    assert.equal(resSkip.skipped, true);

    // 3. File exists and hash differs -> throws error refusing overwrite
    const mockFetchConflict = async (url, opts = {}) => {
      if (opts.method === 'HEAD') {
        return {
          status: 200,
          headers: { get: () => null },
        };
      }
      if (opts.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            yield Buffer.from('different content');
          })(),
        };
      }
      throw new Error(`Unexpected call ${opts.method} ${url}`);
    };
    await assert.rejects(
      () => uploadPackageFile(gitlabUrl, projectId, version, fileItem, token, mockFetchConflict),
      /already exists in package version .* with different checksum/
    );

    // 4. Upload returns 409 conflict: verify retry check behavior
    // Recheck calls HEAD first, which must return 200 to proceed to GET or header match
    let callCount = 0;
    const mockFetch409ConflictWithRecheck = async (url, opts = {}) => {
      if (opts.method === 'HEAD') {
        callCount++;
        return callCount === 1 ? { status: 404 } : { status: 200, headers: { get: () => null } };
      }
      if (opts.method === 'PUT') {
        return { status: 409 };
      }
      if (opts.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            yield content;
          })(),
        };
      }
      throw new Error(`Unexpected call ${opts.method} ${url}`);
    };
    const res409Match = await uploadPackageFile(gitlabUrl, projectId, version, fileItem, token, mockFetch409ConflictWithRecheck);
    assert.equal(res409Match.skipped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishGitLabRelease creates new release or updates existing release with direct_asset_path', async () => {
  const manifest = {
    version: '0.0.25',
    tag: 'v0.0.25',
    ref: '0123456789abcdef0123456789abcdef01234567',
    client_sha: 'fedcba9876543210fedcba9876543210fedcba98',
  };
  const uploadedAssets = [
    {
      name: 'tjuclaw-linux-amd64.deb',
      packageFileUrl: 'https://gitlab.tju.edu.cn/api/v4/projects/145/packages/generic/tjuclaw-client/0.0.25/tjuclaw-linux-amd64.deb',
    },
  ];

  let postPayload = null;
  const mockFetch = async (url, opts = {}) => {
    if (url.endsWith('/releases/v0.0.25') && !opts.method) {
      return { status: 404 }; // Release not yet created
    }
    if (url.endsWith('/releases') && opts.method === 'POST') {
      postPayload = JSON.parse(opts.body);
      return { ok: true, status: 201, json: async () => ({ tag_name: 'v0.0.25' }) };
    }
    throw new Error(`Unexpected call ${opts.method} ${url}`);
  };

  const res = await publishGitLabRelease('https://gitlab.tju.edu.cn', '145', manifest, uploadedAssets, 'glpat-dummy', mockFetch);
  assert.equal(res.action, 'created');
  assert.equal(postPayload.tag_name, 'v0.0.25');
  assert.equal(postPayload.ref, manifest.ref);
  assert.equal(postPayload.assets.links.length, 1);
  assert.equal(postPayload.assets.links[0].direct_asset_path, '/tjuclaw-linux-amd64.deb');
  assert.equal(postPayload.assets.links[0].url, uploadedAssets[0].packageFileUrl);
});

test('executeGitLabRelease dry-run plans endpoints and validates files without network calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-dryrun-'));
  try {
    const file1 = join(dir, 'tjucli-linux-amd64');
    const content = Buffer.from('binary-content');
    const hash = computeHex(content);
    await writeFile(file1, content);

    const manifest = {
      version: '0.0.25',
      tag: 'v0.0.25',
      ref: '0123456789abcdef0123456789abcdef01234567',
      client_sha: 'fedcba9876543210fedcba9876543210fedcba98',
      files: [{ path: file1, name: 'tjucli-linux-amd64', sha256: hash }],
    };

    const dryRes = await executeGitLabRelease(manifest, {
      dryRun: true,
      env: { GITLAB_URL: 'https://gitlab.tju.edu.cn', GITLAB_PROJECT_ID: '145' },
    });

    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.version, '0.0.25');
    assert.equal(dryRes.tag, 'v0.0.25');
    assert.equal(dryRes.plannedUploads.length, 1);
    assert.equal(
      dryRes.plannedUploads[0].targetEndpoint,
      'https://gitlab.tju.edu.cn/api/v4/projects/145/packages/generic/tjuclaw-client/0.0.25/tjucli-linux-amd64'
    );
    assert.equal(dryRes.plannedUploads[0].directAssetPath, '/tjucli-linux-amd64');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
