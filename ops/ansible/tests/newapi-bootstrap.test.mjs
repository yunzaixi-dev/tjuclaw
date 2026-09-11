import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = join(root, 'ops/ansible/roles/newapi_stack/files/bootstrap_newapi.py');

function runScript(credsPath, baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [scriptPath, credsPath], {
      env: { ...process.env, NEWAPI_BASE_URL: baseUrl }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('NewAPI bootstrap helper: initial setup, idempotency, option updates, and security error handling', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'newapi-bootstrap-test-'));
  const credsPath = join(directory, 'credentials.json');
  writeFileSync(credsPath, JSON.stringify({
    admin_username: 'testadmin',
    admin_password: 'TestPassword123!'
  }));

  let server;
  let baseUrl;

  // Mock server state
  let setupCompleted = false;
  let rootInit = false;
  let putRequests = [];
  let failPut = false;
  let malformedOptions = false;
  let missingUserId = false;

  server = createServer((req, res) => {
    const url = new URL(req.url, baseUrl || 'http://127.0.0.1');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}

      if (req.method === 'GET' && url.pathname === '/api/setup') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { status: setupCompleted, root_init: rootInit, database_type: 'sqlite' }
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/setup') {
        if (setupCompleted) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '系统已经初始化完成' }));
          return;
        }
        setupCompleted = true;
        rootInit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '系统初始化成功' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/user/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (missingUserId) {
          res.end(JSON.stringify({ success: true, data: { user: {} } }));
        } else {
          res.end(JSON.stringify({
            success: true,
            data: {
              access_token: 'fake-jwt-token',
              user: { id: 42, username: 'testadmin' }
            }
          }));
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/option/') {
        if (malformedOptions) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: 'invalid-not-a-list' }));
          return;
        }
        const regEnabled = putRequests.find(p => p.key === 'RegisterEnabled')?.value || 'true';
        const pwRegEnabled = putRequests.find(p => p.key === 'PasswordRegisterEnabled')?.value || 'true';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: [
            { key: 'RegisterEnabled', value: regEnabled },
            { key: 'PasswordRegisterEnabled', value: pwRegEnabled },
            { key: 'Theme', value: 'default' }
          ]
        }));
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/option/') {
        if (failPut) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'database locked error secret' }));
          return;
        }
        // Verify New-Api-User header was passed
        if (req.headers['new-api-user'] !== '42') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        putRequests = putRequests.filter(p => p.key !== parsed.key);
        putRequests.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        const regEnabled = putRequests.find(p => p.key === 'RegisterEnabled')?.value || 'true';
        const pwRegEnabled = putRequests.find(p => p.key === 'PasswordRegisterEnabled')?.value || 'true';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: {
            register_enabled: regEnabled === 'true',
            password_register_enabled: pwRegEnabled === 'true',
            version: 'v1.0.0-rc.36'
          }
        }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Initial setup run: should call POST /api/setup, update options, and report success
    setupCompleted = false;
    rootInit = false;
    putRequests = [];
    const run1 = await runScript(credsPath, baseUrl);
    assert.equal(run1.status, 0, `Run 1 failed: ${run1.stderr}`);
    assert.match(run1.stdout, /Setup completed successfully\./);
    assert.match(run1.stdout, /Registration disabled successfully\./);
    assert.match(run1.stdout, /NewAPI bootstrap and verification verified successfully\./);
    assert.equal(putRequests.length, 2);

    // 2. Rerun when already initialized and options already disabled: no writes to options, idempotent
    putRequests = [
      { key: 'RegisterEnabled', value: 'false' },
      { key: 'PasswordRegisterEnabled', value: 'false' }
    ];
    const initialPutCount = putRequests.length;
    const run2 = await runScript(credsPath, baseUrl);
    assert.equal(run2.status, 0, `Run 2 failed: ${run2.stderr}`);
    assert.match(run2.stdout, /System already initialized\./);
    assert.match(run2.stdout, /Registration settings already configured\./);
    assert.match(run2.stdout, /NewAPI bootstrap and verification verified successfully\./);
    // Put requests count should not have increased
    assert.equal(putRequests.length, initialPutCount);

    // 3. Option update refusal / failure: must fail and NOT leak response bodies or secrets
    setupCompleted = true;
    failPut = true;
    putRequests = []; // triggers need to update
    const runFail = await runScript(credsPath, baseUrl);
    assert.notEqual(runFail.status, 0);
    assert.match(runFail.stderr, /PUT \/api\/option\/ for RegisterEnabled/);
    assert.doesNotMatch(runFail.stderr, /database locked error secret/);
    assert.doesNotMatch(runFail.stdout, /database locked error secret/);
    failPut = false;

    // 4. Malformed options response: fails cleanly
    malformedOptions = true;
    const runMalformed = await runScript(credsPath, baseUrl);
    assert.notEqual(runMalformed.status, 0);
    assert.match(runMalformed.stderr, /data is not a list/);
    malformedOptions = false;

    // 5. Missing user ID on login: fails cleanly
    missingUserId = true;
    const runMissingUser = await runScript(credsPath, baseUrl);
    assert.notEqual(runMissingUser.status, 0);
    assert.match(runMissingUser.stderr, /valid user id/);
    missingUserId = false;

    // 6. root_init alone does not mean setup complete: GET /api/setup with status:false, root_init:true must trigger POST /api/setup
    setupCompleted = false;
    rootInit = true;
    putRequests = [];
    const runRootInit = await runScript(credsPath, baseUrl);
    assert.equal(runRootInit.status, 0, `RootInit run failed: ${runRootInit.stderr}`);
    assert.match(runRootInit.stdout, /Setup completed successfully\./);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
