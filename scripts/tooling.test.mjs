import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CI builds every requested client via a defined Task command with private artifacts', () => {
  const ci = parse(read('.gitlab-ci.yml'));
  const tasks = parse(read('Taskfile.yml')).tasks;
  for (const platform of ['web', 'android', 'linux', 'windows']) {
    const job = ci[`build:${platform}`];
    assert.ok(job);
    assert.equal(job.artifacts.access, 'maintainer');
    assert.ok(tasks[job.script[0].replace('task ', '')]);
    assert.ok(job.artifacts.paths.every((path) => !/private|research|\.env/.test(path)));
  }
});

test('Compose exposes only loopback and never mounts repository or host control sockets', () => {
  const compose = parse(read('compose.yaml'));
  for (const service of Object.values(compose.services)) {
    assert.ok(service.ports.every((port) => port.startsWith('127.0.0.1:')));
    assert.equal(service.privileged, undefined);
    assert.equal(service.volumes, undefined);
    assert.equal(service.env_file, undefined);
    assert.equal(service.read_only, true);
  }
  assert.ok(read('.dockerignore').includes('\n**\n'));
});

test('native product version comes from root and default capability is minimal', () => {
  const config = JSON.parse(read('frontend/src-tauri/tauri.conf.json'));
  assert.equal(config.version, '../../package.json');
  assert.equal(config.build.frontendDist, '../dist');
  assert.match(config.app.security.csp, /default-src 'self'/);
  const capability = JSON.parse(read('frontend/src-tauri/capabilities/default.json'));
  assert.deepEqual(capability.permissions, ['core:app:allow-version']);
  assert.deepEqual(parse(read('Taskfile.yml')).dotenv, ['.env.toolchain.local']);
});

test('native launcher resolves the pinned CLI without platform-specific shell scripts', () => {
  const script = fileURLToPath(new URL('./native.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'tauri', '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(JSON.parse(read('frontend/package.json')).devDependencies['@tauri-apps/cli']));
  assert.notEqual(spawnSync(process.execPath, [script, 'unknown'], { stdio: 'ignore' }).status, 0);
});

test('email auth policy keeps browser identity boundaries and local mail isolated', () => {
  const config = parse(read('ops/auth/kratos.yml'));
  assert.equal(config.selfservice.methods.code.passwordless_enabled, true);
  assert.equal(config.selfservice.methods.password.enabled, false);
  assert.equal(config.selfservice.methods.oidc.enabled, false);
  assert.equal(config.serve.public.cors.enabled, false);
  assert.equal(config.log.leak_sensitive_values, false);
  assert.equal(config.cookies.domain, undefined);
  assert.equal(config.cookies.same_site, 'Lax');
  assert.deepEqual(config.selfservice.flows.registration.after.code.hooks, [{ hook: 'session' }]);
  const local = parse(read('ops/auth/compose.yaml'));
  for (const service of Object.values(local.services)) {
    assert.ok((service.ports || []).every(port => port.startsWith('127.0.0.1:')));
    assert.ok((service.volumes || []).every(path => !path.includes('docker.sock')));
  }
  assert.equal(local.services.db.ports, undefined);
  assert.ok(local.services.kratos.ports.every(port => !port.endsWith(':4434')));
  assert.match(read('ops/images/nginx.conf'), /limit_req_status 429/);
  assert.match(read('ops/images/nginx.conf'), /access_log off/);
  const browser = parse(read('.gitlab-ci.yml'))['check:browser'];
  assert.equal(browser.resource_group, 'local-auth-regression');
  assert.equal(browser.artifacts.access, 'maintainer');
  assert.ok(browser.script.includes('task auth:test'));
});
