import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { prependToolPath } from '../frontend/scripts/native-env.mjs';
import { isReusableKratosDevState, isolateTestApiEnv } from './auth-test-stack.mjs';

import { renderDocuments } from './generate-design-doc.mjs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('CI retains every build and mandatory regression with bounded artifacts', () => {
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
  const rootJobs = expandJobs(workflow.jobs);
  const publicClientJobs = expandJobs(clientJobs, 'frontend/');
  const windowsJobs = expandJobs(windowsWorkflow.jobs, 'frontend/');
  assert.equal(workflow.jobs.ops['runs-on'], 'tjuclaw-ops');
  assert.ok(rootJobs.filter(job => job !== workflow.jobs.ops).every(job => job['runs-on'] === 'tjuclaw'));
  assert.ok(publicClientJobs.every(job => ['ubuntu-24.04', 'macos-15'].includes(job['runs-on'])));
  assert.ok(windowsJobs.every(job => job['runs-on'] === 'windows-2022'));
  for (const [path, label] of [
    ['backend/.github/workflows/ci.yml', 'tjuclaw-server'],
    ['crawler/.github/workflows/ci.yml', 'tjuclaw-crawler'],
    ['crawler/.github/workflows/image.yml', 'tjuclaw-crawler'],
    ['cli/.github/workflows/ci.yml', 'tjucli'],
  ]) {
    assert.ok(Object.values(parse(read(path)).jobs).every(job => job['runs-on'] === label), `${path} uses ${label}`);
  }
  const allJobs = [...rootJobs, ...publicClientJobs, ...windowsJobs];
  const commands = allJobs.flatMap(job => (job.steps ?? []).flatMap(step =>
    [...(step.run ?? '').matchAll(/\btask ([\w:-]+)/g)].map(match => match[1])));
  for (const command of ['check', 'auth:test', 'compose:config',
    'compose:context', 'web:build', 'docs:build', 'api:build', 'cli:build',
    'linux:build', 'android:build', 'windows:build']) {
    assert.ok(tasks[command], `Task ${command} is defined`);
    assert.ok(commands.includes(command), `CI runs ${command}`);
  }
  const browserRun = jobs.browser.steps.find(step => step.run?.includes('playwright test'))?.run ?? '';
  assert.match(browserRun, /scripts\/playwright\.config\.mjs/);
  assert.match(browserRun, /scripts\/workspace\.playwright\.config\.mjs/);
  for (const job of allJobs) {
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 120);
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

test('sandbox image check builds pinned private sources without gating the API release', () => {
  const workflow = parse(read('.github/workflows/ci.yml'));
  const job = workflow.jobs['sandbox-images'];
  assert.equal(job['runs-on'], 'tjuclaw');
  assert.ok(!workflow.jobs.deploy.needs.includes('sandbox-images'));
  const steps = job.steps;
  const cliRef = steps.find(step => step.id === 'cli');
  assert.match(cliRef.run, /git ls-tree HEAD cli/);
  const cliCheckout = steps.find(step => step.with?.repository === 'yunzaixi-dev/tjucli');
  assert.equal(cliCheckout.with.ref, '${{ steps.cli.outputs.sha }}');
  assert.equal(cliCheckout.with['ssh-key'], '${{ secrets.CLI_READ_KEY }}');
  const keyGate = steps.find(step => step.name === 'Require sandbox repository access');
  assert.equal(keyGate.env.SANDBOX_READ_KEY, '${{ secrets.SANDBOX_READ_KEY }}');
  assert.match(keyGate.run, /available=false/);
  assert.doesNotMatch(keyGate.run, /exit 1/);
  for (const step of steps.slice(steps.indexOf(keyGate) + 1)) assert.equal(step.if, "steps.access.outputs.available == 'true'");
  const sandboxCheckout = steps.find(step => step.uses === './.github/actions/checkout-sandbox');
  assert.equal(sandboxCheckout.with['sandbox-key'], '${{ secrets.SANDBOX_READ_KEY }}');
  const action = parse(read('.github/actions/checkout-sandbox/action.yml'));
  assert.match(action.runs.steps[0].run, /git ls-tree HEAD sandbox/);
  assert.equal(action.runs.steps[1].with.ref, '${{ steps.ref.outputs.sha }}');
  assert.equal(action.runs.steps[1].with['persist-credentials'], false);
  const smoke = steps.find(step => step.name === 'Build and smoke-test sandbox images').run;
  assert.match(smoke, /docker build --file sandbox\/image\/controller\.Dockerfile/);
  assert.match(smoke, /bash sandbox\/ops\/controller-image-smoke\.sh/);
  assert.match(smoke, /docker build --file sandbox\/image\/gateway\.Dockerfile/);
  assert.doesNotMatch(smoke, /docker push|--push/);
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
  assert.deepEqual(capability.permissions, [
    'core:app:allow-version',
    'allow-store-get',
    'allow-store-set',
    'allow-store-delete',
    'allow-store-list',
  ]);
  assert.deepEqual(parse(read('Taskfile.yml')).dotenv, ['.env.toolchain.local']);
});

test('image generation task keeps provider credentials local and configurable', () => {
  const tasks = parse(read('Taskfile.yml')).tasks;
  assert.equal(tasks['image:generate'].dotenv[0], '.env.image.local');
  assert.deepEqual(tasks['image:generate'].cmds, ['node scripts/generate-image.mjs {{.CLI_ARGS}}']);
  assert.match(read('.env.image.example'), /IMAGE_MODEL=gpt-image-2\.5-flare/);
  assert.doesNotMatch(read('.env.image.example'), /IMAGE_API_KEY=\S+/);
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
  assert.equal(config.selfservice.methods.password.enabled, true);
  assert.equal(config.selfservice.methods.oidc.enabled, false);
  assert.equal(config.serve.public.cors.enabled, false);
  assert.equal(config.log.leak_sensitive_values, false);
  assert.equal(config.cookies.domain, undefined);
  assert.equal(config.cookies.same_site, 'Lax');
  assert.deepEqual(config.selfservice.flows.registration.after.code.hooks, [{ hook: 'session' }]);
  assert.equal(config.identity.default_schema_id, 'tjuclaw-email-tju-v2');
  assert.deepEqual(config.identity.schemas.map(schema => schema.id), ['tjuclaw-email-v1', 'tjuclaw-email-tju-v2']);
  const campusSchema = JSON.parse(read('ops/auth/identity.schema.tju.json'));
  const campusEmail = campusSchema.properties.traits.properties.email;
  const pattern = new RegExp(campusEmail.pattern);
  for (const email of ['student@tju.edu.cn', 'STUDENT@TJU.EDU.CN']) assert.match(email, pattern);
  for (const email of ['student@sub.tju.edu.cn', 'student@tju.edu.cn.evil.com', 'student@example.com']) assert.doesNotMatch(email, pattern);
  assert.equal(campusEmail['ory.sh/kratos'].credentials.code.identifier, true);
  assert.equal(JSON.parse(read('ops/auth/identity.schema.json')).properties.traits.properties.email.pattern, campusEmail.pattern);
  const local = parse(read('ops/auth/compose.yaml'));
  assert.ok(local.services.kratos.volumes.some(volume => volume.includes('identity.schema.tju.json')));
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


test('ZITADEL leftover development state is not reused for Kratos task dev', () => {
  const directory = '/tmp/tjuclaw-auth-dev';
  assert.equal(isReusableKratosDevState({
    directory,
    cookieKey: 'cookie',
    env: { CAP_ADMIN_KEY: 'cap', AUTH_IDENTITY_PORT: '14436' },
  }, directory), false);
  assert.equal(isReusableKratosDevState({
    directory,
    provider: 'kratos',
    cookieKey: 'cookie',
    env: { CAP_ADMIN_KEY: 'cap', AUTH_KRATOS_PORT: '14436' },
  }, directory), true);
  assert.match(read('scripts/auth-test-stack.mjs'), /recreating isolated Kratos credentials/);
});

test('task dev starts the Web client only after the Kratos API is ready', () => {
  const tasks = parse(read('Taskfile.yml')).tasks;
  assert.equal(tasks.dev.deps, undefined);
  assert.deepEqual(tasks.dev.cmds, [
    'node scripts/dev-ports.mjs web',
    'node scripts/dev-ports.mjs api',
    'node scripts/dev-ports.mjs docs',
    'node scripts/auth-test-stack.mjs --dev --web',
  ]);

  assert.match(read('scripts/auth-test-stack.mjs'), /process\.argv\.includes\('--web'\)/);
  assert.match(read('scripts/auth-test-stack.mjs'), /github.com\/air-verse\/air@v1\.67\.4/);

  assert.match(read('scripts/auth-test-stack.mjs'), /'build', '-o', executable/);
  assert.match(read('scripts/auth-test-stack.mjs'), /'--dir', 'docs', 'exec', 'next'/);
  assert.match(read('scripts/auth-test-stack.mjs'), /overlayProductModel/);
  assert.match(read('scripts/auth-test-stack.mjs'), /NEWAPI_BASE_URL/);

  assert.equal(tasks['api:dev'].cmds[0], 'go run github.com/air-verse/air@v1.67.4 -c .air.toml');
});

test('isolated auth API never inherits live model, sandbox, or campus credentials', () => {
  const inherited = {
    NEWAPI_BASE_URL: 'https://model.invalid', NEWAPI_API_KEY: 'live-model',
    NEWAPI_MODEL: 'billable-model', NEWAPI_MODELS: 'billable-model,other', NEWAPI_QUOTA_5H: '100', NEWAPI_QUOTA_7D: '900',
    SANDBOX_SESSION_URL: 'https://sandbox.invalid', SANDBOX_SESSION_TOKEN: 'legacy-token',
    SANDBOX_GATEWAY_HMAC_SECRET: 'live-sandbox-secret',
    SANDBOX_GATEWAY_PUBLIC_URL: 'https://public-sandbox.invalid',
    WPY_APP_TICKET: 'live-campus-ticket', HTTP_ADDR: '127.0.0.1:18089',
  };
  const isolated = isolateTestApiEnv(inherited);
  assert.deepEqual(isolated, { HTTP_ADDR: inherited.HTTP_ADDR });
  assert.equal(inherited.SANDBOX_SESSION_URL, 'https://sandbox.invalid');
});

test('homepage source stays synchronized with generated README and DESIGN documents', () => {
  const source = read('docs/content/docs/index.md');
  const generated = renderDocuments(source);
  assert.equal(generated.readme, read('README.md'));
  assert.equal(generated.design, read('DESIGN.md'));
  assert.match(read('.githooks/pre-commit'), /generate-design-doc\.mjs --check-index/);
  assert.match(read('Taskfile.yml'), /docs:check-sync/);
});
