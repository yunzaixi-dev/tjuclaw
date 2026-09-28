import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';

// Runs the sandbox gateway against this machine's Docker engine for `task dev`:
// one hardened controller container per Agent session, workspaces as local
// bare Git repositories, and the product model key kept in the gateway.

export const LOCAL_SANDBOX_IMAGE = 'tjuclaw-controller:local';
const GATEWAY_PORT = 18080;

export function localSandboxAvailable(env) {
  if (env.AUTH_DEV_SANDBOX === '0') return { ok: false, reason: 'disabled by AUTH_DEV_SANDBOX=0' };
  if (!env.NEWAPI_BASE_URL || !env.NEWAPI_API_KEY) return { ok: false, reason: 'no NEWAPI_* model in .env.auth.local' };
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10000 });
  if (docker.status !== 0) return { ok: false, reason: 'Docker is not running' };
  return { ok: true };
}

function imageExists() {
  return spawnSync('docker', ['image', 'inspect', LOCAL_SANDBOX_IMAGE], { stdio: 'ignore', timeout: 15000 }).status === 0;
}

function healthy(url) {
  return new Promise(resolveCheck => {
    const req = http.get(`${url}/healthz`, { timeout: 2000 }, res => { res.resume(); resolveCheck(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveCheck(false));
  });
}

/** Builds the image if needed, starts the gateway and returns what the API needs. */
export async function startLocalSandbox({ root, apiPort, env }) {
  if (!imageExists()) {
    console.log(`Building ${LOCAL_SANDBOX_IMAGE} for the local Agent sandbox (first run only)…`);
    const build = spawnSync('docker', ['build', '-f', 'sandbox/image/controller.Dockerfile', '-t', LOCAL_SANDBOX_IMAGE, '.'], { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('Local sandbox image build failed');
  }
  const repos = join(root, 'ops/local/sandbox/repos');
  await mkdir(repos, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  const url = `http://127.0.0.1:${GATEWAY_PORT}`;
  const child = spawn('go', ['run', './cmd/gateway'], {
    cwd: join(root, 'sandbox'),
    stdio: 'inherit',
    env: {
      PATH: env.PATH, HOME: env.HOME, GOPATH: env.GOPATH ?? '', GOCACHE: env.GOCACHE ?? '', GOFLAGS: env.GOFLAGS ?? '',
      SANDBOX_RUNTIME: 'docker',
      SANDBOX_IMAGE: LOCAL_SANDBOX_IMAGE,
      SANDBOX_GATEWAY_ADDR: `127.0.0.1:${GATEWAY_PORT}`,
      SANDBOX_SESSION_TOKEN: randomBytes(32).toString('hex'),
      SANDBOX_GATEWAY_HMAC_SECRET: secret,
      SANDBOX_LOCAL_GIT_DIR: repos,
      SANDBOX_TOOL_API_URL: `http://127.0.0.1:${apiPort}/agent/sandbox-tools`,
      NEWAPI_BASE_URL: env.NEWAPI_BASE_URL,
      NEWAPI_API_KEY: env.NEWAPI_API_KEY,
      NEWAPI_MODEL: env.NEWAPI_MODEL || (env.NEWAPI_MODELS ?? '').split(',')[0] || 'tju-llm',
      NEWAPI_MODELS: env.NEWAPI_MODELS ?? '',
      // The API enforces the rolling 5h/7d windows; this is only a backstop.
      BROKER_QUOTA_LIMIT: '10000',
    },
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('Local sandbox gateway exited during startup');
    if (await healthy(url)) return { url, secret, child };
    await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  }
  child.kill('SIGTERM');
  throw new Error('Local sandbox gateway did not become ready');
}
