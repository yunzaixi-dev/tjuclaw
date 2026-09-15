import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAuthDevMailConfig } from './auth-mail-config.mjs';

// Tests are disposable; --dev keeps identities and credentials across restarts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');
const devDirectory = join(root, 'ops/local/auth-dev');
const statePath = development ? join(devDirectory, 'state.json') : join(root, 'ops/local/auth-test-stack.json');
const project = development ? 'tjuclaw-auth-dev' : 'tjuclaw-auth-test';
const composeArgs = ['compose', '-p', project, '-f', 'ops/auth/compose.yaml'];
const identityPort = development ? 4433 : 14435;
const mailPort = development ? 8025 : 18026;
const capPort = development ? 13302 : 13301;
const apiPort = development ? 8080 : 18089;
const publicOrigin = development ? 'http://127.0.0.1:5173' : 'http://127.0.0.1:1423';
let runtime, api, web, docs, stopping = false;

const secret = () => randomBytes(24).toString('hex');
const compose = (args, env) => spawnSync('docker', [...composeArgs, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', timeout: 180000 });
export function isReusableKratosDevState(saved, directory) {
  return saved?.directory === directory
    && saved.provider === 'kratos'
    && Boolean(saved.cookieKey)
    && Boolean(saved.env?.CAP_ADMIN_KEY)
    && Boolean(saved.env?.AUTH_KRATOS_PORT);
}
function composeResetEnv(saved) {
  return {
    CAP_ADMIN_KEY: saved?.env?.CAP_ADMIN_KEY || 'legacy-reset',
    AUTH_KRATOS_PORT: saved?.env?.AUTH_KRATOS_PORT || saved?.env?.AUTH_IDENTITY_PORT || String(identityPort),
    AUTH_MAIL_PORT: saved?.env?.AUTH_MAIL_PORT || String(mailPort),
    AUTH_CAP_PORT: saved?.env?.AUTH_CAP_PORT || String(capPort),
  };
}
async function discardUnusableDevState(saved) {
  console.log('Local development identity state is not Kratos; recreating isolated Kratos credentials.');
  const result = compose(['down', '--volumes', '--remove-orphans'], composeResetEnv(saved));
  if (result.status !== 0) throw new Error('Could not remove leftover local identity volumes; check Docker and retry.');
  await rm(statePath, { force: true });
}

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
async function overlayProductModel(env) {
  let text = '';
  try {
    text = await readFile(join(root, '.env.auth.local'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return env;
  }
  const allow = new Set(['NEWAPI_BASE_URL', 'NEWAPI_API_KEY', 'NEWAPI_MODEL', 'NEWAPI_DAILY_QUOTA']);
  const next = { ...env };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!allow.has(key) || next[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    next[key] = value;
  }
  return next;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), new Promise(resolveWait => setTimeout(resolveWait, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function cleanup(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await stopChild(api);
  await stopChild(web);
  await stopChild(docs);

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
async function main() {
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
  if (!process.argv.includes('--up')) {
    // Never let an existing API satisfy the new child's readiness check.
    await new Promise((resolvePort, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error(`API port ${apiPort} is occupied; start with task auth:dev to release this project's old API.`)));
      probe.listen(apiPort, '127.0.0.1', () => probe.close(resolvePort));
    });
  }
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (!development) throw new Error('Existing isolated test stack state; run node scripts/auth-test-stack.mjs --down first');
    if (isReusableKratosDevState(saved, devDirectory)) runtime = saved;
    else await discardUnusableDevState(saved);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!runtime && development) {
    const volumes = spawnSync('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], { encoding: 'utf8' });
    if (volumes.status !== 0 || volumes.stdout.trim()) throw new Error('Cannot create development credentials: existing volumes or unavailable Docker');
  }
  const directory = runtime?.directory ?? (development ? devDirectory : await mkdtemp(join(tmpdir(), 'tjuclaw-auth-')));
  const mailConfig = await resolveAuthDevMailConfig(root, process.env, { development });
  if (!runtime) {
    runtime = { directory, provider: 'kratos', cookieKey: randomBytes(32).toString('base64'), env: {
      CAP_ADMIN_KEY: secret(),
      AUTH_KRATOS_PORT: String(identityPort), AUTH_MAIL_PORT: String(mailPort), AUTH_CAP_PORT: String(capPort),
      AUTH_BROWSER_URL: publicOrigin,
      ...mailConfig.composeEnv,
    } };
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    await writeFile(statePath, JSON.stringify(runtime), { mode: 0o600, flag: 'wx' });
  } else {
    if (runtime.env.AUTH_BROWSER_URL && runtime.env.AUTH_BROWSER_URL !== publicOrigin) {
      runtime.site = undefined;
    }
    runtime.env = {
      ...runtime.env,
      AUTH_BROWSER_URL: publicOrigin,
      AUTH_KRATOS_PORT: String(identityPort),
      AUTH_MAIL_PORT: String(mailPort),
      AUTH_CAP_PORT: String(capPort),
      ...mailConfig.composeEnv,
    };
  }

  console.log(`Starting isolated Kratos, Cap and ${mailConfig.mode === 'real' ? 'real-delivery SMTP' : 'captured-mail'} services.`);
  if (compose(['up', '--detach'], runtime.env).status !== 0) {
    const logs = spawnSync('docker', [...composeArgs, 'logs', '--no-color', '--tail', '35', 'kratos'], { cwd: root, env: { ...process.env, ...runtime.env }, encoding: 'utf8' });
    let diagnostic = (logs.stdout ?? '') + (logs.stderr ?? '');
    for (const value of Object.values(runtime.env).filter(value => value.length >= 16)) diagnostic = diagnostic.replaceAll(value, '[redacted]');
    await writeFile(join(dirname(statePath), 'stack-startup.log'), diagnostic, { mode: 0o600 });
    throw new Error('Isolated identity stack startup failed; private diagnostics: test-results/auth/stack-startup.log');
  }
  const identityBase = `http://127.0.0.1:${identityPort}`;
  await ready(identityBase, '/health/ready');
  if (mailConfig.mode === 'captured') await ready(`http://127.0.0.1:${mailPort}`, '/api/v1/messages');
  await ready(`http://127.0.0.1:${capPort}`, '/');

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
  const backendDir = join(root, 'backend');
  const apiEnv = await overlayProductModel({
    ...process.env, HTTP_ADDR: `127.0.0.1:${apiPort}`, DATABASE_URL: '',
    TASK_DATA_DIR: join(directory, 'tasks'), AUTH_PROVIDER: 'kratos',
    APP_PUBLIC_URL: publicOrigin, KRATOS_PUBLIC_URL: identityBase,
    AUTH_COOKIE_KEY: runtime.cookieKey,
    CAP_URL: capBase, CAP_SITE_KEY: site.siteKey, CAP_SECRET_KEY: site.secretKey,
  });

  if (development) {
    api = spawn('go', ['run', 'github.com/air-verse/air@v1.67.4', '-c', '.air.toml'], { cwd: backendDir, stdio: 'inherit', env: apiEnv });
  } else {
    const executable = join(directory, 'tjuclaw-api');
    const build = spawnSync('go', ['build', '-o', executable, './cmd/api'], { cwd: backendDir, stdio: 'inherit', timeout: 120000 });
    if (build.status !== 0) throw new Error('API build failed');
    api = spawn(executable, [], { cwd: directory, stdio: 'inherit', env: apiEnv });
  }

  api.on('error', () => { console.error('Isolated API could not start'); void cleanup(1); });
  api.on('exit', code => { if (!stopping) { console.error(`Isolated API exited (${code})`); void cleanup(1); } });
  await ready(`http://127.0.0.1:${apiPort}`, '/auth/flow');
  console.log(`Kratos + Cap API ready at 127.0.0.1:${apiPort}${development ? ' (Air live reload)' : ''}; ${mailConfig.mode === 'real' ? 'real SMTP configured' : `mailbox: http://127.0.0.1:${mailPort}`}`);
  if (process.argv.includes('--web')) {
    web = spawn('pnpm', ['--dir', 'frontend', 'dev'], { cwd: root, stdio: 'inherit', env: process.env });
    web.on('error', () => { console.error('Web client could not start'); void cleanup(1); });
    web.on('exit', code => { if (!stopping) { console.error(`Web client exited (${code})`); void cleanup(code ?? 1); } });
    docs = spawn('pnpm', ['--dir', 'docs', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', '3000'], { cwd: root, stdio: 'inherit', env: process.env });
    docs.on('error', () => { console.error('Docs could not start'); void cleanup(1); });
    docs.on('exit', code => { if (!stopping) { console.error(`Docs exited (${code})`); void cleanup(code ?? 1); } });
  }

} catch (error) {
  console.error(error.message);
  await cleanup(1);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
