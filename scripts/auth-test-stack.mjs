import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAuthDevMailConfig, syncZitadelSmtpProvider } from './auth-mail-config.mjs';

// Tests are disposable; --dev keeps identities and credentials across restarts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');
const devDirectory = join(root, 'ops/local/auth-dev');
const statePath = development ? join(devDirectory, 'state.json') : join(root, 'ops/local/auth-test-stack.json');
const project = development ? 'tjuclaw-zitadel-dev' : 'tjuclaw-auth-test';
const composeArgs = ['compose', '-p', project, '-f', 'ops/auth/zitadel/compose.yml'];
const identityPort = development ? 14436 : 14435;
const mailPort = development ? 18027 : 18026;
const capPort = development ? 13302 : 13301;
const apiPort = development ? 18088 : 18089;
const publicOrigin = development ? 'http://127.0.0.1:1420' : 'http://127.0.0.1:1423';
let runtime, api, stopping = false;
const secret = () => randomBytes(24).toString('hex');
const compose = (args, env) => spawnSync('docker', [...composeArgs, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', timeout: 180000 });
function request(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveRequest, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(new URL(path, base), { method, headers: { 'Content-Type': 'application/json', ...headers }, timeout: 10000 }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 1 << 20) req.destroy(new Error('oversized response')); else chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let value;
        try { value = JSON.parse(text); } catch { value = null; }
        resolveRequest({ status: res.statusCode, value });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject); req.end(data);
  });
}
async function ready(base, path, headers = {}) {
  for (let attempt = 0; attempt < 90 && !stopping; attempt++) {
    try { if ((await request(base, path, { headers })).status === 200) return; } catch { /* bounded startup retry */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Service did not become ready: ${base}${path}`);
}
async function json(base, path, options = {}) {
  const res = await request(base, path, options);
  if (res.status < 200 || res.status >= 300 || res.value === null) throw new Error(`Bootstrap request failed: ${path} HTTP ${res.status}`);
  return res.value;
}
async function cleanup(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (api && api.exitCode === null) {
    api.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => api.once('exit', resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 5000))]);
    if (api.exitCode === null) api.kill('SIGKILL');
  }
  if (runtime && !development) {
    const result = compose(['down', '--volumes', '--remove-orphans'], runtime.env);
    if (result.status !== 0) exitCode = 1;
    else {
      await rm(runtime.directory, { recursive: true, force: true });
      await rm(statePath, { force: true });
    }
  }
  process.exit(exitCode);
}
if (process.argv.includes('--down')) {
  try { runtime = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; process.exit(0); }
  if (!runtime.env || (development ? runtime.directory !== devDirectory : !runtime.directory?.startsWith(join(tmpdir(), 'tjuclaw-auth-')))) throw new Error('Invalid isolated stack state');
  if (development) process.exit(compose(['down'], runtime.env).status === 0 ? 0 : 1);
  await cleanup();
}
process.on('SIGTERM', () => { void cleanup(); });
process.on('SIGINT', () => { void cleanup(); });
try {
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (!development) throw new Error('Existing isolated test stack state; run node scripts/auth-test-stack.mjs --down first');
    if (saved.directory !== devDirectory || !saved.env?.ZITADEL_MASTERKEY || !saved.env?.ZITADEL_DATABASE_PASSWORD || !saved.env?.CAP_ADMIN_KEY) throw new Error('Invalid local development state; refusing to replace credentials');
    runtime = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!runtime && development) {
    const volumes = spawnSync('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], { encoding: 'utf8' });
    if (volumes.status !== 0 || volumes.stdout.trim()) throw new Error('Cannot create development credentials: existing volumes or unavailable Docker');
  }
  const directory = runtime?.directory ?? (development ? devDirectory : await mkdtemp(join(tmpdir(), 'tjuclaw-auth-')));
  const bootstrap = join(directory, 'bootstrap');
  await mkdir(bootstrap, { recursive: true, mode: 0o700 });
  const mailConfig = await resolveAuthDevMailConfig(root, process.env, { development });
  if (!runtime) {
    runtime = { directory, cookieKey: randomBytes(32).toString('base64'), env: {
      ZITADEL_MASTERKEY: randomBytes(16).toString('hex'),
      ZITADEL_DATABASE_PASSWORD: secret(), CAP_ADMIN_KEY: secret(),
      ZITADEL_BOOTSTRAP_DIR: bootstrap,
      AUTH_TEST_UID: String(process.getuid?.() ?? 1000), AUTH_TEST_GID: String(process.getgid?.() ?? 1000),
      AUTH_IDENTITY_PORT: String(identityPort), AUTH_MAIL_PORT: String(mailPort), AUTH_CAP_PORT: String(capPort),
      ...mailConfig.composeEnv,
    } };
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify(runtime), { mode: 0o600, flag: 'wx' });
  } else {
    runtime.env = { ...runtime.env, ...mailConfig.composeEnv };
  }
  console.log(`Starting isolated ZITADEL, Cap and ${mailConfig.mode === 'real' ? 'real-delivery SMTP' : 'captured-mail'} services.`);
  if (compose(['up', '--detach'], runtime.env).status !== 0) {
    const logs = spawnSync('docker', [...composeArgs, 'logs', '--no-color', '--tail', '35', 'zitadel-setup'], { cwd: root, env: { ...process.env, ...runtime.env }, encoding: 'utf8' });
    let diagnostic = (logs.stdout ?? '') + (logs.stderr ?? '');
    for (const value of Object.values(runtime.env).filter(value => value.length >= 16)) diagnostic = diagnostic.replaceAll(value, '[redacted]');
    await writeFile(join(dirname(statePath), 'stack-startup.log'), diagnostic, { mode: 0o600 });
    throw new Error('Isolated identity stack startup failed; private diagnostics: test-results/auth/stack-startup.log');
  }
  const identityBase = `http://127.0.0.1:${identityPort}`;
  const identityHost = { Host: `localhost:${identityPort}` };
  await ready(identityBase, '/debug/ready', identityHost);
  await ready(`http://127.0.0.1:${mailPort}`, '/api/v1/messages');
  await ready(`http://127.0.0.1:${capPort}`, '/');
  const owner = (await readFile(join(bootstrap, 'owner.pat'), 'utf8')).trim();
  const loginToken = (await readFile(join(bootstrap, 'login-client.pat'), 'utf8')).trim();
  await chmod(join(bootstrap, 'owner.pat'), 0o600);
  await chmod(join(bootstrap, 'login-client.pat'), 0o600);
  let organizations;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await request(identityBase, '/v2/organizations/_search', { method: 'POST', headers: { ...identityHost, Authorization: `Bearer ${owner}` }, body: { queries: [{ nameQuery: { name: 'TJUClaw Test', method: 'TEXT_QUERY_METHOD_EQUALS' } }] } });
    if (result.status === 200) { organizations = result.value; break; }
    if (result.status !== 503 || attempt === 29) {
      await writeFile(join(dirname(statePath), 'bootstrap-error.json'), JSON.stringify({ status: result.status, response: result.value }), { mode: 0o600 });
      throw new Error('Organization bootstrap query failed; private diagnostics: test-results/auth/bootstrap-error.json');
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  const org = organizations.result?.find(item => item.name === 'TJUClaw Test');
  if (!org?.id || !loginToken) throw new Error('Missing isolated organization or login-client PAT');

  if (development && mailConfig.smtp) {
    // Persistent development identities must switch providers when mode changes.
    await syncZitadelSmtpProvider(identityBase, owner, `localhost:${identityPort}`, mailConfig.smtp);
  }

  const capBase = `http://127.0.0.1:${capPort}`;
  let site = runtime.site;
  if (!site) {
    const login = await json(capBase, '/auth/login', { method: 'POST', body: { admin_key: runtime.env.CAP_ADMIN_KEY } });
    if (!login.success || !login.session_token || !login.hashed_token) throw new Error('Cap bootstrap authentication failed');
    const capAuth = `Bearer ${Buffer.from(JSON.stringify({ token: login.session_token, hash: login.hashed_token })).toString('base64')}`;
    site = await json(capBase, '/server/keys', { method: 'POST', headers: { Authorization: capAuth }, body: { name: development ? 'TJUClaw Development' : 'TJUClaw Test', corsOrigins: [publicOrigin] } });
    if (!site.siteKey || !site.secretKey) throw new Error('Cap site key provisioning failed');
    runtime.site = { siteKey: site.siteKey, secretKey: site.secretKey };
    await writeFile(statePath, JSON.stringify(runtime), { mode: 0o600 });
  }
  if (development && process.argv.includes('--up')) {
    console.log(`Local identity services ready; ${mailConfig.mode === 'real' ? 'real SMTP configured' : `captured mailbox: http://127.0.0.1:${mailPort}`}`);
    process.exit(0);
  }
  const executable = join(directory, 'tjuclaw-api');
  const build = spawnSync('go', ['build', '-o', executable, './cmd/api'], { cwd: join(root, 'backend'), stdio: 'inherit', timeout: 120000 });
  if (build.status !== 0) throw new Error('API build failed');
  api = spawn(executable, [], { cwd: directory, stdio: 'inherit', env: {
    ...process.env, HTTP_ADDR: `127.0.0.1:${apiPort}`, DATABASE_URL: '',
    TASK_DATA_DIR: join(directory, 'tasks'), AUTH_PROVIDER: 'zitadel',
    APP_PUBLIC_URL: publicOrigin, ZITADEL_URL: identityBase,
    ZITADEL_DOMAIN: `localhost:${identityPort}`, ZITADEL_ORG_ID: org.id,
    ZITADEL_TOKEN: loginToken, AUTH_COOKIE_KEY: runtime.cookieKey,
    CAP_URL: capBase, CAP_SITE_KEY: site.siteKey, CAP_SECRET_KEY: site.secretKey,
  } });
  api.on('error', () => { console.error('Isolated API could not start'); void cleanup(1); });
  api.on('exit', code => { if (!stopping) { console.error(`Isolated API exited (${code})`); void cleanup(1); } });
  await ready(`http://127.0.0.1:${apiPort}`, '/auth/flow');
  console.log(`ZITADEL + Cap API ready at 127.0.0.1:${apiPort}; ${mailConfig.mode === 'real' ? 'real SMTP configured' : `mailbox: http://127.0.0.1:${mailPort}`}`);
} catch (error) {
  console.error(error.message);
  await cleanup(1);
}
