import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { prependToolPath } from '../frontend/scripts/native-env.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('hosted CI retains every build and mandatory regression with bounded artifacts', () => {
  const tasks = parse(read('Taskfile.yml')).tasks;
  const workflow = parse(read('.github/workflows/ci.yml'));
  assert.ok(workflow.on.push);
  assert.ok(workflow.on.pull_request);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.permissions.contents, 'read');

  // Native jobs belong to the pinned client; integration keeps real auth.
  const clientJobs = parse(read('frontend/.github/workflows/ci.yml')).jobs;
  assert.equal(workflow.jobs['build-linux'], undefined);
  assert.equal(workflow.jobs['build-android'], undefined);
  assert.ok(workflow.jobs.mirror);
  const jobs = { ...workflow.jobs, ...clientJobs };
  assert.ok(jobs['check']);
  assert.ok(jobs['browser']);
  assert.ok(jobs['integration']);
  assert.ok(jobs['build-artifacts']);
  assert.ok(jobs['build-linux']);
  assert.ok(jobs['build-android']);

  const windowsWorkflow = parse(read('frontend/.github/workflows/windows.yml'));
  const expandJobs = (source, prefix = '') => Object.values(source).flatMap(job => {
    if (!job.uses) return [job];
    assert.match(job.uses, /^\.\/\.github\/workflows\/[a-z-]+\.yml$/);
    return Object.values(parse(read(prefix + job.uses.slice(2))).jobs);
  });
  const allJobs = [...expandJobs(workflow.jobs), ...expandJobs(clientJobs, 'frontend/'), ...expandJobs(windowsWorkflow.jobs, 'frontend/')];
  const commands = allJobs.flatMap(job => (job.steps ?? []).flatMap(step =>
    [...(step.run ?? '').matchAll(/\btask ([\w:-]+)/g)].map(match => match[1])));
  for (const command of ['check', 'ui:test', 'workspace:test', 'auth:test', 'compose:config',
    'compose:context', 'web:build', 'docs:build', 'api:build', 'cli:build',
    'linux:build', 'android:build', 'windows:build']) {
    assert.ok(tasks[command], `Task ${command} is defined`);
    assert.ok(commands.includes(command), `CI runs ${command}`);
  }
  for (const job of allJobs) {
    assert.ok(!String(job['runs-on']).includes('self-hosted'));
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
    for (const step of (job.steps ?? []).filter(step => step.uses?.startsWith('actions/upload-artifact@'))) {
      assert.equal(step.with['if-no-files-found'], 'error');
      assert.ok(!step.with.path.includes('test-results'));
    }
  }
  const integrationSteps = jobs.integration.steps;
  const pullIndex = integrationSteps.findIndex(step => step.run?.includes('docker pull oryd/kratos:v26.2.0'));
  assert.ok(pullIndex >= 0 && pullIndex < integrationSteps.findIndex(step => step.run === 'task auth:test'));
  assert.ok(integrationSteps.some(step => step.if === 'always()' && step.run === 'node scripts/auth-test-stack.mjs --down'));
  assert.match(read('scripts/auth-test-stack.mjs'), /\['down', '--volumes', '--remove-orphans'\]/);
  assert.deepEqual(parse(read('.gitlab-ci.yml')).workflow.rules, [{ when: 'never' }]);
  assert.ok(windowsWorkflow.on.push);
  assert.ok(windowsWorkflow.on.pull_request);
  assert.ok(windowsWorkflow.on.workflow_dispatch !== undefined);
  assert.equal(windowsWorkflow.on.pull_request_target, undefined);
  assert.equal(windowsWorkflow.permissions.contents, 'read');
});

test('Windows workflow is configured with pinned actions and checksums', () => {
  const workflow = parse(read('frontend/.github/workflows/windows.yml'));
  assert.equal(workflow.permissions.contents, 'read');
  const job = workflow.jobs.windows;
  assert.equal(job['runs-on'], 'windows-2022');
  for (const step of (job.steps ?? []).filter(step => step.uses)) {
    assert.match(step.uses, /@[a-f0-9]{40}$/);
  }
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const artifact = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.with['retention-days'], 7);
  assert.equal(artifact.with['if-no-files-found'], 'error');
  assert.ok(artifact.with.path.split('\n').filter(Boolean)
    .every(path => path.startsWith('src-tauri/target/release/bundle/nsis/')));
  assert.ok(job.steps.some(step => step.run === 'pnpm install --frozen-lockfile --fetch-timeout 600000 --network-concurrency 4'));
});

test('CI preflight selects the correct executor toolchain before dependency installation', () => {
  const steps = parse(read('frontend/.github/workflows/windows.yml')).jobs.windows.steps;
  assert.ok(steps.findIndex(step => step.run === 'node scripts/ci-preflight.mjs windows') <
    steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile --fetch-timeout 600000 --network-concurrency 4'));
});

test('Compose exposes only loopback and never mounts repository or host control sockets', () => {
  const compose = parse(read('compose.yaml'));
  assert.deepEqual(compose.volumes, { 'task-data': null });
  for (const [name, service] of Object.entries(compose.services)) {
    assert.ok(service.ports.every((port) => port.startsWith('127.0.0.1:')));
    assert.equal(service.privileged, undefined);
    assert.deepEqual(service.volumes, name === 'api' ? ['task-data:/var/lib/tjuclaw/tasks'] : undefined);
    assert.equal(service.env_file, undefined);
    assert.equal(service.read_only, true);
  }
  assert.ok(read('.dockerignore').includes('\n**\n'));
});

test('native product version comes from root and default capability is minimal', () => {
  const config = JSON.parse(read('frontend/src-tauri/tauri.conf.json'));
  assert.equal(config.version, '../package.json');
  assert.equal(config.build.frontendDist, '../dist');
  assert.match(config.app.security.csp, /default-src 'self'/);
  const capability = JSON.parse(read('frontend/src-tauri/capabilities/default.json'));
  assert.deepEqual(capability.permissions, ['core:app:allow-version']);
  assert.deepEqual(parse(read('Taskfile.yml')).dotenv, ['.env.toolchain.local']);
});

test('native launcher preserves Windows Path when adding rustup for child processes', () => {
  const source = { Path: 'C:\\pnpm;C:\\Windows\\System32', OTHER: 'preserved' };
  const child = prependToolPath(source, 'C:\\cargo\\bin', 'win32');
  assert.equal(child.PATH, 'C:\\cargo\\bin;C:\\pnpm;C:\\Windows\\System32');
  assert.deepEqual(Object.keys(child).filter(key => key.toLowerCase() === 'path'), ['PATH']);
  assert.equal(source.Path, 'C:\\pnpm;C:\\Windows\\System32');
  assert.equal(child.OTHER, source.OTHER);
  assert.equal(prependToolPath({ PATH: '/usr/bin' }, '/cargo/bin', 'linux').PATH, '/cargo/bin:/usr/bin');
});

test('native launcher resolves the pinned CLI without platform-specific shell scripts', () => {
  const script = fileURLToPath(new URL('../frontend/scripts/native.mjs', import.meta.url));
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
  const zitadelCompose = parse(read('ops/auth/zitadel/compose.yml'));
  for (const service of Object.values(zitadelCompose.services)) {
    assert.ok((service.ports || []).every(port => port.startsWith('127.0.0.1:')));
  }
  assert.equal(zitadelCompose.services['zitadel-db'].ports, undefined);
  assert.match(read('ops/images/nginx.conf'), /limit_req_status 429/);
  assert.match(read('ops/images/nginx.conf'), /access_log off/);
});
