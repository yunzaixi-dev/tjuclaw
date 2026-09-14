import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readlinkSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
function run(variables) {
  return new Promise((resolve, reject) => {
    const child = spawn('uv', ['run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
      'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/deploy-api.yml', '-e', JSON.stringify(variables), '--connection=local'],
    { cwd: root, env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' } });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('close', status => resolve({ status, output }));
  });
}
test('API deployment validates before mutation, preserves immutable releases and rolls back failed switches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tjuclaw-deploy-'));
  let health = 200;
  const server = createServer((_req, res) => { res.writeHead(health); res.end('health'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const artifact = join(directory, 'artifact'), envFile = join(directory, 'api.env'), base = join(directory, 'opt');
  writeFileSync(artifact, 'version1');
  const vars = { api_release_sha: 'a'.repeat(40), api_artifact_path: artifact, api_artifact_sha256: digest('version1'),
    api_env_file: envFile, api_base_dir: base, api_data_dir: join(directory, 'data'),
    api_listen_addr: `127.0.0.1:${server.address().port}`, api_verify_kratos_ready: false,
    api_deploy_simulate_systemd: true, api_deploy_become: false, api_health_timeout_seconds: 1 };
  try {
    let result = await run(vars);
    assert.notEqual(result.status, 0); assert.match(result.output, /ABSENT/); assert.ok(!existsSync(base));
    writeFileSync(envFile, 'APP_PUBLIC_URL=http://app.example.invalid\nKRATOS_PUBLIC_URL=http://127.0.0.1:4433\n');
    result = await run(vars);
    assert.notEqual(result.status, 0); assert.match(result.output, /must define APP_PUBLIC_URL/); assert.ok(!existsSync(base));
    writeFileSync(envFile, 'APP_PUBLIC_URL=https://app.example.invalid\nKRATOS_PUBLIC_URL=http://127.0.0.1:4433\nHTTP_ADDR=0.0.0.0:9999\nTASK_DATA_DIR=/tmp/wrong\nAUTH_COOKIE_KEY=dGVzdC1hdXRoLWNvb2tpZS1rZXktMzI=\nCAP_URL=http://127.0.0.1:3300\nCAP_SITE_KEY=site\nCAP_SECRET_KEY=secret\n');
    result = await run({ ...vars, api_artifact_sha256: '0'.repeat(64) });
    assert.notEqual(result.status, 0); assert.match(result.output, /does not match expected/); assert.ok(!existsSync(base));
    result = await run(vars);
    assert.equal(result.status, 0, result.output);
    assert.equal(readlinkSync(join(base, 'current')), join(base, 'releases', vars.api_release_sha));
    const previousUnit = readFileSync(join(base, 'tjuclaw-api.service'), 'utf8');
    assert.ok(previousUnit.includes(`ExecStart=/usr/bin/env HTTP_ADDR=${vars.api_listen_addr} TASK_DATA_DIR=${vars.api_data_dir} `));
    result = await run(vars);
    assert.equal(result.status, 0, result.output); assert.match(result.output, /changed=0\b/);
    writeFileSync(artifact, 'version2');
    result = await run({ ...vars, api_artifact_sha256: digest('version2') });
    assert.notEqual(result.status, 0); assert.match(result.output, /Refusing to overwrite/);
    assert.equal(readFileSync(join(base, 'releases', vars.api_release_sha, 'api'), 'utf8'), 'version1');
    health = 500;
    result = await run({ ...vars, api_release_sha: 'b'.repeat(40), api_artifact_sha256: digest('version2') });
    assert.notEqual(result.status, 0); assert.match(result.output, /Rollback completed/);
    assert.equal(readlinkSync(join(base, 'current')), join(base, 'releases', vars.api_release_sha));
    assert.equal(readFileSync(join(base, 'tjuclaw-api.service'), 'utf8'), previousUnit);
    const firstBase = join(directory, 'first-failure');
    result = await run({ ...vars, api_base_dir: firstBase, api_artifact_sha256: digest('version2') });
    assert.notEqual(result.status, 0); assert.match(result.output, /Rollback completed/);
    assert.ok(!existsSync(join(firstBase, 'current'))); assert.ok(!existsSync(join(firstBase, 'tjuclaw-api.service')));
  } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('ZITADEL deployment checks its configured instance and rejects incomplete credentials before mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tjuclaw-zitadel-deploy-'));
  const paths = [];
  let identityHealthy = false;
  const server = createServer((req, res) => {
    paths.push(req.url);
    const ready = req.url === '/debug/ready';
    res.writeHead(ready && (!identityHealthy || req.headers.host !== 'identity.example.invalid') ? 503 : 200);
    res.end('health');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const artifact = join(directory, 'artifact'), envFile = join(directory, 'api.env'), base = join(directory, 'opt');
  const listen = `127.0.0.1:${server.address().port}`;
  writeFileSync(artifact, 'zitadel-version');
  const vars = { api_release_sha: 'c'.repeat(40), api_artifact_path: artifact, api_artifact_sha256: digest('zitadel-version'),
    api_env_file: envFile, api_base_dir: base, api_data_dir: join(directory, 'data'), api_listen_addr: listen,
    api_deploy_simulate_systemd: true, api_deploy_become: false, api_health_timeout_seconds: 1 };
  const settings = `APP_PUBLIC_URL=https://app.example.invalid\nAUTH_PROVIDER=zitadel\nZITADEL_URL=http://${listen}\nZITADEL_DOMAIN=identity.example.invalid\nZITADEL_ORG_ID=test-org\nZITADEL_TOKEN=synthetic-pat\nAUTH_COOKIE_KEY=${Buffer.alloc(32, 3).toString('base64')}\nCAP_URL=http://127.0.0.1:13301\nCAP_SITE_KEY=synthetic-site\n`;
  try {
    writeFileSync(envFile, settings);
    let result = await run(vars);
    assert.notEqual(result.status, 0); assert.ok(!existsSync(base));
    assert.ok(!result.output.includes('synthetic-pat'));
    writeFileSync(envFile, `${settings}CAP_SECRET_KEY=synthetic-secret\n`);
    result = await run(vars);
    assert.notEqual(result.status, 0); assert.ok(!existsSync(base));
    assert.deepEqual(paths, ['/debug/ready']);
    identityHealthy = true;
    result = await run(vars);
    assert.equal(result.status, 0, result.output);
    assert.equal(readlinkSync(join(base, 'current')), join(base, 'releases', vars.api_release_sha));
    assert.ok(!paths.some(path => path.includes('/health/ready')));
    assert.ok(!result.output.includes('synthetic-pat'));
    assert.ok(!result.output.includes('synthetic-secret'));
  } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
});
