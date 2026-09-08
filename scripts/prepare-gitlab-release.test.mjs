import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBuildManifest } from './prepare-gitlab-release.mjs';

const sha = 'a'.repeat(40);
const manifest = () => ({ source_sha: sha, version: '0.0.25', files: ['deb', 'apk', 'exe'].map(extension => ({
  name: `client.${extension}`, size: 100, sha256: 'b'.repeat(64),
})) });

test('promotion requires the pinned client and exactly one package per native platform', () => {
  assert.equal(validateBuildManifest(manifest(), sha).source_sha, sha);
  assert.throws(() => validateBuildManifest(manifest(), 'c'.repeat(40)), /pinned/);
  const duplicate = manifest();
  duplicate.files[2].name = 'other.apk';
  assert.throws(() => validateBuildManifest(duplicate, sha), /Duplicate/);
  const missing = manifest();
  missing.files.pop();
  assert.throws(() => validateBuildManifest(missing, sha), /three/);
});

test('promotion rejects arbitrary files, traversal, excessive sizes and invalid digests', () => {
  for (const change of [{ name: '../client.exe' }, { name: '.env' }, { size: 0 }, { size: 2 ** 31 }, { sha256: 'invalid' }]) {
    const altered = manifest();
    Object.assign(altered.files[0], change);
    assert.throws(() => validateBuildManifest(altered, sha));
  }
});
