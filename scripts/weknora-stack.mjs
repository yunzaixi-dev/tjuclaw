import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const composeFile = join(root, 'ops/weknora/compose.yaml');
const exampleFile = join(root, 'ops/weknora/env.example');
const envDir = join(root, 'ops/local/weknora');
const envFile = join(envDir, '.env');
const project = 'tjuclaw-weknora-dev';
const healthURL = 'http://127.0.0.1:18181/health';

const secretKeys = {
  DB_PASSWORD: () => randomBytes(32).toString('hex'),
  REDIS_PASSWORD: () => randomBytes(32).toString('hex'),
  JWT_SECRET: () => randomBytes(32).toString('hex'),
  SYSTEM_AES_KEY: () => randomBytes(16).toString('hex'),
};

export function ensureWeKnoraEnv(directory = envDir, example = exampleFile) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, '.env');
  if (existsSync(path)) {
    return path;
  }
  let text = readFileSync(example, 'utf8');
  for (const [key, make] of Object.entries(secretKeys)) {
    text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${make()}`);
  }
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

function compose(args, envPath = envFile) {
  const extra = existsSync(envPath) ? ['--env-file', envPath] : [];
  const result = spawnSync('docker', ['compose', '-p', project, ...extra, '-f', composeFile, ...args], {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed`);
  }
}

async function waitHealth(url = healthURL, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return;
      }
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`WeKnora health not ready at ${url}`);
}

function envPort(key, fallback) {
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const match = text.match(new RegExp(`^${key}=(\\S+)`, 'm'));
  return match ? match[1] : fallback;
}

const command = process.argv[2] ?? 'up';
const isMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (isMain) {
  if (command === 'down') {
    compose(['down']);
  } else if (command === 'up') {
    ensureWeKnoraEnv();
    compose(['up', '-d']);
    await waitHealth();
    console.log(`WeKnora UI http://127.0.0.1:${envPort('FRONTEND_PORT', '18180')}`);
    console.log(`WeKnora app http://127.0.0.1:${envPort('WEKNORA_APP_HOST_PORT', '18181')}/health`);
  } else {
    throw new Error(`unknown command ${command}`);
  }
}
