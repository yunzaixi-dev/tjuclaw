import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'yunzaixi-dev/tjuclaw';
const shaPattern = /^[a-f0-9]{40}$/;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, ...options })?.trim() ?? '';
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyManifest(manifest, bytes, sha, backend) {
  if (!shaPattern.test(sha ?? '') || !shaPattern.test(backend ?? '') ||
      manifest.repository !== repository || manifest.commit !== sha || manifest.backend !== backend ||
      manifest.platform !== 'linux-amd64' || manifest.sha256 !== checksum(bytes)) {
    throw new Error('Artifact provenance or checksum mismatch');
  }
  return manifest.sha256;
}
export function deploymentTarget(env) {
  for (const name of ['DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS', 'DEPLOY_HOST', 'DEPLOY_USER']) {
    if (!env[name]?.trim()) throw new Error(`Missing production environment configuration: ${name}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.DEPLOY_HOST) ||
      !/^[a-z_][a-z0-9_-]*$/.test(env.DEPLOY_USER)) throw new Error('Invalid SSH host or user');
  return { host: env.DEPLOY_HOST, user: env.DEPLOY_USER };
}
function main() {
  const sha = run('git', ['rev-parse', 'HEAD']);
  const backend = run('git', ['rev-parse', 'HEAD:backend']);
  const artifact = resolve('backend/bin/deploy');
  const bytes = readFileSync(join(artifact, 'api'));
  if (process.argv.includes('--manifest')) {
    if (sha !== process.env.GITHUB_SHA || process.env.GITHUB_REPOSITORY !== repository) throw new Error('Untrusted build checkout');
    const manifest = { repository, commit: sha, backend, platform: 'linux-amd64', sha256: checksum(bytes) };
    writeFileSync(join(artifact, 'metadata.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(artifact, 'SHA256SUMS'), `${manifest.sha256}  api\n`);
    return;
  }
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/release' ||
      process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_SHA !== sha) throw new Error('Deployment requires a trusted release push');
  const manifest = JSON.parse(readFileSync(join(artifact, 'metadata.json'), 'utf8'));
  const digest = verifyManifest(manifest, bytes, sha, backend);
  if (readFileSync(join(artifact, 'SHA256SUMS'), 'utf8') !== `${digest}  api\n`) throw new Error('Checksum manifest mismatch');
  const latest = () => run('gh', ['api', `repos/${repository}/git/ref/heads/release`, '--jq', '.object.sha']);
  if (latest() !== sha) { console.log('A newer release exists; obsolete deployment skipped.'); return; }
  const { host, user } = deploymentTarget(process.env);
  const directory = mkdtempSync(join(tmpdir(), 'tjuclaw-deploy-'));
  try {
    const key = join(directory, 'identity'), known = join(directory, 'known_hosts');
    writeFileSync(key, process.env.DEPLOY_SSH_KEY.trim() + '\n', { mode: 0o600 });
    writeFileSync(known, process.env.DEPLOY_KNOWN_HOSTS.trim() + '\n', { mode: 0o600 });
    const inventory = { all: { hosts: { production_api: {
      ansible_host: host, ansible_user: user, ansible_port: 22,
      ansible_ssh_private_key_file: key,
      ansible_ssh_common_args: `-F /dev/null -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${known}`,
      ansible_python_interpreter: '/usr/bin/python3',
    } } } };
    writeFileSync(join(directory, 'inventory.json'), JSON.stringify(inventory), { mode: 0o600 });
    writeFileSync(join(directory, 'vars.json'), JSON.stringify({ api_release_sha: sha, api_artifact_sha256: digest, api_artifact_path: join(artifact, 'api') }), { mode: 0o600 });
    if (latest() !== sha) { console.log('A newer release exists; obsolete deployment skipped.'); return; }
    const env = { ...process.env, ANSIBLE_CONFIG: resolve('ops/ansible/ansible.cfg'), ANSIBLE_HOST_KEY_CHECKING: 'True' };
    for (const name of ['DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS', 'GH_TOKEN']) delete env[name];
    run('uv', ['run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt', 'ansible-playbook',
      '-i', join(directory, 'inventory.json'), 'ops/ansible/playbooks/deploy-api.yml', '-e', '@' + join(directory, 'vars.json')],
    { env, timeout: 600_000, stdio: 'inherit' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error.code || error.status ? 'Deployment command failed; inspect the preceding redacted task output.' : error.message);
    process.exitCode = 1;
  }
}
