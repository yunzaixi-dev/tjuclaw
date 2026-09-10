import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('origin rendering is local, idempotent, and rejects an unrestricted source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tjuclaw-origin-'));
  const variables = {
    candidate_dir: join(directory, 'candidate'),
    origin_hostname: 'app.example.invalid',
    origin_tls_pem: '/etc/haproxy/certs/example.pem',
    origin_backend_address: '127.0.0.1',
    origin_backend_port: 18080,
    origin_allowed_cidrs: ['192.0.2.0/24'],
  };
  const run = (values) => spawnSync('uv', [
    'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
    'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/render-origin.yml',
    '-e', JSON.stringify(values),
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' } });
  try {
    const first = run(variables);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const path = join(variables.candidate_dir, 'haproxy-origin.cfg');
    const original = readFileSync(path, 'utf8');
    assert.match(original, /bind :8443 ssl/);
    assert.match(original, /http-request deny deny_status 403 unless edgeone_source/);
    assert.match(original, /default_backend tjuclaw_api/);
    assert.match(original, /http-request deny deny_status 404 if !api_root !api_path/);
    assert.ok(original.includes('http-request replace-path ^/api/(.*)$ /\\1 if api_path'));
    assert.match(original, /option httpchk GET \/healthz/);
    const second = run(variables);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /changed=0\b/);
    const invalid = run({ ...variables, origin_allowed_cidrs: ['0.0.0.0/0'] });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
