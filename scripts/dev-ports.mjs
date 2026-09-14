import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ports = { web: 1420, api: 18088 };

export function ownsProcess(info, target) {
  if (target === 'web') {
    return info.cwd === resolve(root, 'frontend') && info.argv.some(arg => {
      const path = relative(resolve(root, 'frontend/node_modules'), resolve(info.cwd, arg));
      return /^(?:\.pnpm\/[^/]+\/node_modules\/)?vite\/bin\/vite\.js$/.test(path);
    });
  }
  return target === 'api' && info.cwd === resolve(root, 'ops/local/auth-dev') &&
    info.exe.replace(/ \(deleted\)$/, '') === resolve(root, 'ops/local/auth-dev/tjuclaw-api');
}

function inspect(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {
      cwd: readlinkSync(`/proc/${pid}/cwd`),
      exe: readlinkSync(`/proc/${pid}/exe`),
      argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
      started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    };
  } catch { return null; }
}

export function listeningPids(port) {
  const output = execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 5000 });
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.some(line => !/pid=\d+/.test(line))) {
    throw new Error(`Cannot identify every listener on port ${port}; no processes were stopped.`);
  }
  return [...new Set([...output.matchAll(/pid=(\d+)/g)].map(match => Number(match[1])))];
}

async function isFree(port) {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? done(false) : reject(error));
    server.listen(port, () => server.close(() => done(true)));
  });
}

export async function cleanPort(target) {
  const port = ports[target];
  if (!port) throw new Error('Usage: node scripts/dev-ports.mjs <web|api>');
  if (await isFree(port)) return;
  if (process.platform !== 'linux') {
    throw new Error(`Port ${port} is occupied. Automatic ownership checks require Linux; stop the old development process manually.`);
  }
  const owners = listeningPids(port).map(pid => ({ pid, info: inspect(pid) }));
  if (!owners.length || owners.some(({ pid, info }) => pid === process.pid || !info || !ownsProcess(info, target))) {
    throw new Error(`Port ${port} belongs to an unknown or unrelated process; it was preserved. Stop it manually before retrying.`);
  }
  // Validate every owner before signaling any process, and guard against PID reuse.
  for (const { pid, info } of owners) {
    const current = inspect(pid);
    if (!current) continue;
    if (current.started !== info.started || !ownsProcess(current, target)) throw new Error(`Port ${port} ownership changed; retry startup.`);
    console.log(`Releasing project ${target} on port ${port} (PID ${pid}).`);
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await isFree(port)) return;
    await delay(100);
  }
  for (const { pid, info } of owners) {
    const current = inspect(pid);
    if (current?.started === info.started && ownsProcess(current, target)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await isFree(port)) return;
    await delay(100);
  }
  throw new Error(`Port ${port} is still occupied; startup stopped.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cleanPort(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
