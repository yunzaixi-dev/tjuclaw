import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyManifest, deploymentTarget } from './deploy-release.mjs';
const bytes = Buffer.from('verified executable fixture');
const sha = 'a'.repeat(40), backend = 'b'.repeat(40);
const manifest = { repository: 'yunzaixi-dev/tjuclaw', commit: sha, backend, platform: 'linux-amd64', sha256: createHash('sha256').update(bytes).digest('hex') };
test('deployment rejects swapped bytes and mismatched source provenance', () => {
  assert.equal(verifyManifest(manifest, bytes, sha, backend), manifest.sha256);
  for (const patch of [{ repository: 'attacker/repo' }, { commit: backend }, { backend: sha }, { platform: 'linux-arm64' }])
    assert.throws(() => verifyManifest({ ...manifest, ...patch }, bytes, sha, backend));
  assert.throws(() => verifyManifest(manifest, Buffer.from('changed'), sha, backend));
});
test('SSH deployment config must be explicit and cannot inject options', () => {
  const env = { DEPLOY_SSH_KEY: 'fixture', DEPLOY_KNOWN_HOSTS: 'fixture', DEPLOY_HOST: 'origin.example.invalid', DEPLOY_USER: 'deploy' };
  assert.equal(deploymentTarget(env).user, 'deploy');
  for (const key of Object.keys(env)) assert.throws(() => deploymentTarget({ ...env, [key]: '' }));
  assert.throws(() => deploymentTarget({ ...env, DEPLOY_HOST: '-oProxyCommand=bad' }));
  assert.throws(() => deploymentTarget({ ...env, DEPLOY_USER: 'root;bad' }));
});
