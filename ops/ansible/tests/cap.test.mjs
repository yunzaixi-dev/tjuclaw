import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function runPlaybook(variables) {
  return spawnSync('uv', [
    'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
    'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/deploy-cap.yml',
    '-c', 'local',
    '-e', JSON.stringify(variables),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' }
  });
}

test('cap_stack role preflight assertions, compose rendering, and durable secret preservation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cap-stack-test-'));
  const baseDir = join(directory, 'opt');

  const baseVars = {
    cap_base_dir: baseDir,
    cap_listen_addr: '127.0.0.1:3300',
    cap_simulate: true,
    cap_become: false,
  };

  try {
    // 1. Initial simulation run
    const firstRun = runPlaybook(baseVars);
    assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);

    const envCapPath = join(baseDir, '.env.cap');
    const composePath = join(baseDir, 'compose.yaml');

    assert.ok(existsSync(envCapPath), '.env.cap must exist');
    assert.ok(existsSync(composePath), 'compose.yaml must exist');
    assert.equal(statSync(envCapPath).mode & 0o777, 0o600);
    const parsed = spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, 'Rendered Compose must be accepted by Docker Compose');
    const services = JSON.parse(parsed.stdout).services;
    assert.equal(services.cap.ports[0].host_ip, '127.0.0.1');
    assert.equal(services.valkey.ports, undefined);
    assert.ok(Object.hasOwn(services.cap.networks, 'cap-access'));
    assert.ok(Object.hasOwn(services.valkey.networks, 'cap-internal'));

    const envCapContent = readFileSync(envCapPath, 'utf8');
    const composeContent = readFileSync(composePath, 'utf8');

    // Verify secret generated
    const adminKeyMatch = envCapContent.match(/^ADMIN_KEY=(.+)$/m);
    assert.ok(adminKeyMatch, 'ADMIN_KEY must be present');
    const initialKey = adminKeyMatch[1].trim();
    assert.ok(initialKey.length >= 12, 'ADMIN_KEY must be >= 12 chars');

    // Verify compose content
    assert.match(composeContent, /image: tiago2\/cap:3\.1\.11/);
    assert.match(composeContent, /image: valkey\/valkey:9-alpine/);
    assert.match(composeContent, /127\.0\.0\.1:3300:3000/);
    assert.match(composeContent, /memory: 128m/);
    assert.match(composeContent, /--appendonly yes/);
    assert.match(composeContent, /--maxmemory-policy noeviction/);
    assert.match(composeContent, /internal: true/);
    assert.match(composeContent, /cap-valkey-data/);

    // 2. Secret preservation on subsequent run
    const customizedEnv = `${envCapContent}\n# preserved local setting\nSHOW_ERRORS=false\n`;
    writeFileSync(envCapPath, customizedEnv);
    const secondRun = runPlaybook(baseVars);
    assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);
    const envCapSecond = readFileSync(envCapPath, 'utf8');
    const adminKeyMatchSecond = envCapSecond.match(/^ADMIN_KEY=(.+)$/m);
    assert.equal(adminKeyMatchSecond[1].trim(), initialKey, 'ADMIN_KEY must be preserved across runs');
    assert.equal(envCapSecond, customizedEnv, 'Existing environment must be preserved byte-for-byte');

    // 3. Preflight failure: non-loopback listen address
    const publicListen = runPlaybook({ ...baseVars, cap_listen_addr: '0.0.0.0:3300' });
    assert.notEqual(publicListen.status, 0, 'Must reject non-loopback bind address');

    // 4. Preflight failure: invalid image
    const invalidImage = runPlaybook({ ...baseVars, cap_image: 'invalid image with spaces' });
    assert.notEqual(invalidImage.status, 0, 'Must reject malformed image pin');

    writeFileSync(envCapPath, 'ADMIN_KEY=short\n');
    const damaged = runPlaybook(baseVars);
    assert.notEqual(damaged.status, 0, 'Damaged secrets must fail without replacement');
    assert.equal(readFileSync(envCapPath, 'utf8'), 'ADMIN_KEY=short\n');
    rmSync(envCapPath);
    assert.notEqual(runPlaybook(baseVars).status, 0, 'Missing secrets on an existing deployment must not be regenerated');
    assert.equal(existsSync(envCapPath), false);
    const unrelatedDir = join(directory, 'unrelated');
    mkdirSync(unrelatedDir);
    writeFileSync(join(unrelatedDir, 'keep.txt'), 'existing service');
    assert.notEqual(runPlaybook({ ...baseVars, cap_base_dir: unrelatedDir }).status, 0);
    assert.equal(readFileSync(join(unrelatedDir, 'keep.txt'), 'utf8'), 'existing service');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
