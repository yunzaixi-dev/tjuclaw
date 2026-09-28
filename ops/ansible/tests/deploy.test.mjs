import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readlinkSync, existsSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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
    const validEnv = 'APP_PUBLIC_URL=https://app.example.invalid\nKRATOS_PUBLIC_URL=http://127.0.0.1:4433\nHTTP_ADDR=0.0.0.0:9999\nTASK_DATA_DIR=/tmp/wrong\nAUTH_COOKIE_KEY=dGVzdC1hdXRoLWNvb2tpZS1rZXktMzI=\nCAP_URL=http://127.0.0.1:3300\nCAP_SITE_KEY=site\nCAP_SECRET_KEY=secret\n';
    for (const invalid of [
      'SANDBOX_SESSION_URL=https://sandbox.example.invalid\n',
      `SANDBOX_SESSION_URL=http://sandbox.example.invalid\nSANDBOX_GATEWAY_HMAC_SECRET=${'x'.repeat(32)}\n`,
      'SANDBOX_GATEWAY_HMAC_SECRET=orphaned-secret\n',
    ]) {
      writeFileSync(envFile, validEnv + invalid);
      result = await run(vars);
      assert.notEqual(result.status, 0, result.output);
      assert.ok(!existsSync(base));
      assert.ok(!result.output.includes('orphaned-secret'));
    }
    writeFileSync(envFile, validEnv + 'DATABASE_URL=postgres://example.invalid/database\n');
    result = await run({ ...vars, api_data_dir: join(directory, 'fresh-pg-data'), api_base_dir: join(directory, 'fresh-pg-release') });
    assert.equal(result.status, 0, result.output);
    const existingRecords = join(vars.api_data_dir, 'knowledge', 'owner');
    mkdirSync(existingRecords, { recursive: true });
    writeFileSync(join(existingRecords, 'note.json'), '{"body":"existing data"}');
    writeFileSync(envFile, validEnv + 'DATABASE_URL=postgres://example.invalid/database\n');
    result = await run(vars);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /would hide existing FileStore records/);
    assert.ok(!existsSync(base));
    writeFileSync(join(vars.api_data_dir, '.postgres-migration-verified'), 'test-only migration verification');
    result = await run({ ...vars, api_base_dir: join(directory, 'verified-migration') });
    assert.equal(result.status, 0, result.output);
    rmSync(join(vars.api_data_dir, '.postgres-migration-verified'));
    writeFileSync(envFile, validEnv + `SANDBOX_SESSION_URL=https://sandbox.example.invalid\nSANDBOX_GATEWAY_HMAC_SECRET=${'s'.repeat(32)}\n`);
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
    // An unchanged backend under a new integration SHA reuses the running
    // binary on the host instead of transferring the artifact again.
    health = 200;
    writeFileSync(artifact, 'version1');
    const reuseBase = join(directory, 'reuse');
    result = await run({ ...vars, api_base_dir: reuseBase });
    assert.equal(result.status, 0, result.output);
    const reuseSha = 'c'.repeat(40);
    result = await run({ ...vars, api_base_dir: reuseBase, api_release_sha: reuseSha });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Reuse the running binary when it is this artifact\] \*+\nchanged/);
    assert.match(result.output, /Copy the compressed artifact next to the release binary\] \*+\nskipping/);
    assert.equal(readFileSync(join(reuseBase, 'releases', reuseSha, 'api'), 'utf8'), 'version1');
    assert.equal(readlinkSync(join(reuseBase, 'current')), join(reuseBase, 'releases', reuseSha));
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

test('sandbox preflight validates TLS, private Gateway, and browser-facing routes before mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tjuclaw-sandbox-preflight-'));
  const certificate = join(directory, 'gateway.crt'), key = join(directory, 'gateway.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  let vaultStatusHealthy = false;
  let vaultHealthy = false;
  let readyHealthy = false;
  let edgeVaultStatusHealthy = false;
  let edgeVaultHealthy = false;
  let edgeDeleteHealthy = false;
  let edgeBrowserHealthy = false;
  let edgeCorsHealthy = false;
  let edgeRejectForeignOrigin = false;
  const paths = [];
  const edgePaths = [];
  const gatewayMethods = [];
  const edgeMethods = [];
  const gateway = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (req, res) => {
    paths.push(req.url);
    gatewayMethods.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/readyz') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: readyHealthy ? 'ready' : 'not-ready' }));
    } else if (req.url === '/v1/sessions/ensure' ||
      (vaultStatusHealthy && req.url === '/v1/vault/status') ||
      (vaultHealthy && req.url === '/v1/vault/objects/0123456789abcdef0123456789abcdef')) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { id: 'unauthorized' } }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { id: 'not_found' } }));
    }
  });
  const edge = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (req, res) => {
    edgePaths.push(req.url);
    edgeMethods.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    if (/^\/v1\/sessions\/(notes|note|note\/move|search|graph)$/.test(req.url)) {
      if (!edgeBrowserHealthy) {
        res.writeHead(404); res.end('{"error":{"id":"not_found"}}');
      } else if (req.headers.origin !== 'https://app.example.invalid' && edgeRejectForeignOrigin) {
        res.writeHead(403); res.end('{"error":{"id":"origin_rejected"}}');
      } else if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', edgeCorsHealthy ? 'https://app.example.invalid' : '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.writeHead(204); res.end();
      } else {
        res.writeHead(401); res.end('{"error":{"id":"unauthorized"}}');
      }
      return;
    }
    if (req.url === '/readyz') {
      res.writeHead(200);
      res.end('{"status":"ready"}');
    } else if (edgeVaultHealthy && !edgeDeleteHealthy && req.method === 'DELETE' &&
      req.url === '/v1/vault/objects/0123456789abcdef0123456789abcdef') {
      res.writeHead(405);
      res.end('{"error":{"id":"method_not_allowed"}}');
    } else if (req.url === '/v1/sessions/ensure' || req.url === '/v1/quota' ||
      (edgeVaultStatusHealthy && req.url === '/v1/vault/status') ||
      (edgeVaultHealthy && req.url === '/v1/vault/objects/0123456789abcdef0123456789abcdef')) {
      res.writeHead(401);
      res.end('{"error":{"id":"unauthorized"}}');
    } else {
      res.writeHead(404);
      res.end('{"error":{"id":"not_found"}}');
    }
  });
  const health = createServer((_req, res) => { res.writeHead(200); res.end('health'); });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  const artifact = join(directory, 'artifact'), envFile = join(directory, 'api.env'), base = join(directory, 'opt');
  writeFileSync(artifact, 'sandbox-version');
  writeFileSync(envFile, `APP_PUBLIC_URL=https://app.example.invalid\nKRATOS_PUBLIC_URL=http://127.0.0.1:4433\nAUTH_COOKIE_KEY=${Buffer.alloc(32, 3).toString('base64')}\nCAP_URL=http://127.0.0.1:3300\nCAP_SITE_KEY=site\nCAP_SECRET_KEY=secret\nSANDBOX_SESSION_URL=https://localhost:${gateway.address().port}\nSANDBOX_GATEWAY_PUBLIC_URL=https://localhost:${edge.address().port}\nSANDBOX_GATEWAY_HMAC_SECRET=${'s'.repeat(32)}\n`);
  const vars = { api_release_sha: 'd'.repeat(40), api_artifact_path: artifact, api_artifact_sha256: digest('sandbox-version'),
    api_env_file: envFile, api_base_dir: base, api_data_dir: join(directory, 'data'),
    api_listen_addr: `127.0.0.1:${health.address().port}`, api_verify_kratos_ready: false,
    api_deploy_simulate_systemd: true, api_sandbox_probe_in_simulation: true,
    api_deploy_become: false, api_health_timeout_seconds: 1 };
  try {
    let result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /did not return the expected ready JSON/);
    assert.ok(!existsSync(base));
    readyHealthy = true;
    result = await run(vars);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /certificate verify failed|CERTIFICATE_VERIFY_FAILED/);
    assert.ok(!existsSync(base));
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Status code was 404 and not \[401\]/);
    assert.ok(gatewayMethods.includes('GET /v1/vault/status'));
    assert.ok(!existsSync(base));
    vaultStatusHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Status code was 404 and not \[401\]/);
    assert.ok(paths.includes('/v1/vault/objects/0123456789abcdef0123456789abcdef'));
    assert.ok(!existsSync(base));
    vaultHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Status code was 404 and not \[401\]/);
    assert.ok(edgePaths.includes('/v1/sessions/ensure'));
    assert.ok(edgePaths.includes('/v1/quota'));
    assert.ok(edgeMethods.includes('GET /v1/vault/status'));
    assert.ok(!existsSync(base));
    edgeVaultStatusHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Status code was 404 and not \[401\]/);
    assert.ok(edgePaths.includes('/v1/vault/objects/0123456789abcdef0123456789abcdef'));
    assert.ok(!existsSync(base));
    edgeVaultHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Status code was 405 and not \[401\]/);
    assert.ok(edgeMethods.includes('DELETE /v1/vault/objects/0123456789abcdef0123456789abcdef'));
    assert.ok(!existsSync(base));
    edgeDeleteHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Status code was 404 and not \[204\]/);
    assert.ok(!existsSync(base));
    edgeBrowserHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /browser-facing sandbox CORS/i);
    assert.ok(!existsSync(base));
    edgeCorsHealthy = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /cross-origin/i);
    assert.ok(!existsSync(base));
    edgeRejectForeignOrigin = true;
    result = await run({ ...vars, api_sandbox_preflight_ca_path: certificate });
    assert.equal(result.status, 0, result.output);
    assert.ok(paths.includes('/v1/sessions/ensure'));
    assert.ok(paths.includes('/v1/vault/objects/0123456789abcdef0123456789abcdef'));
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assert.ok(gatewayMethods.includes(`${method} /v1/vault/objects/0123456789abcdef0123456789abcdef`));
      assert.ok(edgeMethods.includes(`${method} /v1/vault/objects/0123456789abcdef0123456789abcdef`));
    }
    for (const route of ['/v1/sessions/notes', '/v1/sessions/note', '/v1/sessions/note/move',
      '/v1/sessions/search', '/v1/sessions/graph']) {
      assert.ok(edgeMethods.includes(`OPTIONS ${route}`));
    }
    assert.ok(edgeMethods.includes('POST /v1/sessions/notes'));
    assert.equal(readlinkSync(join(base, 'current')), join(base, 'releases', vars.api_release_sha));
    assert.ok(!result.output.includes('s'.repeat(32)));
  } finally {
    gateway.close();
    edge.close();
    health.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sandbox cutover refuses legacy objects and an unavailable or incomplete cluster inventory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tjuclaw-sandbox-inventory-'));
  const artifact = join(directory, 'artifact'), envFile = join(directory, 'api.env');
  const base = join(directory, 'opt'), inventory = join(directory, 'inventory.json');
  const kubectl = join(directory, 'kubectl'), argumentsFile = join(directory, 'kubectl-args');
  const health = createServer((_req, res) => { res.writeHead(200); res.end('health'); });
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  writeFileSync(artifact, 'sandbox-inventory-version');
  writeFileSync(envFile, `APP_PUBLIC_URL=https://app.example.invalid\nKRATOS_PUBLIC_URL=http://127.0.0.1:4433\nAUTH_COOKIE_KEY=${Buffer.alloc(32, 3).toString('base64')}\nCAP_URL=http://127.0.0.1:3300\nCAP_SITE_KEY=site\nCAP_SECRET_KEY=secret\nSANDBOX_SESSION_URL=https://sandbox.example.invalid\nSANDBOX_GATEWAY_HMAC_SECRET=${'s'.repeat(32)}\n`);
  writeFileSync(kubectl, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\ncat ${JSON.stringify(inventory)}\n`);
  chmodSync(kubectl, 0o755);
  const vars = { api_release_sha: 'e'.repeat(40), api_artifact_path: artifact,
    api_artifact_sha256: digest('sandbox-inventory-version'), api_env_file: envFile, api_base_dir: base,
    api_data_dir: join(directory, 'data'), api_listen_addr: `127.0.0.1:${health.address().port}`,
    api_verify_kratos_ready: false, api_deploy_simulate_systemd: true,
    api_sandbox_kube_probe_in_simulation: true, api_deploy_become: false,
    api_sandbox_kubectl_path: kubectl, api_health_timeout_seconds: 1 };
  const bound = { metadata: { name: 'session-a', namespace: 'tjuclaw-sandbox-runtime',
    annotations: { 'tjuclaw.io/session-binding': 'a'.repeat(64) } } };
  try {
    writeFileSync(inventory, JSON.stringify({ kind: 'List', items: [] }));
    let result = await run(vars);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /explicit api_sandbox_kube_context/);
    assert.ok(!existsSync(base));

    const configured = { ...vars, api_sandbox_kube_context: 'admin@prod-sg' };
    writeFileSync(kubectl, '#!/bin/sh\nexit 1\n');
    result = await run(configured);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Cannot inspect live Sandbox resources/);
    assert.ok(!existsSync(base));
    writeFileSync(kubectl, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\ncat ${JSON.stringify(inventory)}\n`);
    result = await run(configured);
    assert.equal(result.status, 0, result.output);
    assert.match(readFileSync(argumentsFile, 'utf8'), /--context\nadmin@prod-sg\n--namespace\ntjuclaw-sandbox-runtime\nget\nsandboxes.agents.x-k8s.io/);
    assert.equal(readlinkSync(join(base, 'current')), join(base, 'releases', vars.api_release_sha));

    for (const value of [
      { kind: 'List' },
      { kind: 'List', items: [{ metadata: { name: 'legacy', namespace: 'tjuclaw-sandbox-runtime' } }] },
      { kind: 'List', items: [{ metadata: { name: 'forged', namespace: 'tjuclaw-sandbox-runtime',
        annotations: { 'tjuclaw.io/session-binding': 'not-a-digest' } } }] },
    ]) {
      writeFileSync(inventory, JSON.stringify(value));
      const failed = await run({ ...configured, api_base_dir: join(directory, 'blocked') });
      assert.notEqual(failed.status, 0, failed.output);
      assert.ok(!existsSync(join(directory, 'blocked')));
    }
    writeFileSync(inventory, JSON.stringify({ kind: 'List', items: [bound] }));
    result = await run({ ...configured, api_base_dir: join(directory, 'bound') });
    assert.equal(result.status, 0, result.output);
  } finally {
    health.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
