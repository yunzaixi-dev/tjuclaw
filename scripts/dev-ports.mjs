import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ports = { web: 5173, api: 8080, docs: 3000 };
const alsoFree = { web: [1420], api: [18088], docs: [3030] };

export function ownsProcess(info, target) {
  if (target === 'web') {
    return info.cwd === resolve(root, 'frontend') && info.argv.some(arg => {
      const path = relative(resolve(root, 'frontend/node_modules'), resolve(info.cwd, arg));
      return /^(?:\.pnpm\/[^/]+\/node_modules\/)?vite\/bin\/vite\.js$/.test(path);
    });
  }
  if (target === 'docs') {
    if (info.cwd !== resolve(root, 'docs')) return false;
    return info.argv[0]?.startsWith('next-server') || info.argv.some(arg => {
      const path = relative(resolve(root, 'docs/node_modules'), resolve(info.cwd, arg));
      return /^(?:\.pnpm\/[^/]+\/node_modules\/)?next\/dist\/bin\/next$/.test(path);
    });
  }
  if (target !== 'api') return false;
  const exe = info.exe.replace(/ \(deleted\)$/, '');
  if (info.cwd === resolve(root, 'ops/local/auth-dev') && exe === resolve(root, 'ops/local/auth-dev/tjuclaw-api')) return true;
  if (info.cwd === resolve(root, 'backend') && exe === resolve(root, 'backend/tmp/api')) return true;
  return isAirSupervisor(info);
}

function isAirSupervisor(info) {
  return info.cwd === resolve(root, 'backend') && info.argv.some(arg => arg === 'air' || arg.includes('air-verse/air') || arg.endsWith('/air'));
}

function reclaimPid(pid, info, target) {
  if (target === 'web') return pid;
  const parent = inspect(info.ppid);
  if (target === 'docs') return parent && ownsProcess(parent, 'docs') ? info.ppid : pid;
  return parent && isAirSupervisor(parent) ? info.ppid : pid;
}



function inspect(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      cwd: readlinkSync(`/proc/${pid}/cwd`),
      exe: readlinkSync(`/proc/${pid}/exe`),
      argv: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
      started: fields[19],
      ppid: Number(fields[1]),
    };
  } catch { return null; }
}


export function listeningPids(port) {
  const output = execFileSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8', timeout: 5000 });
  const lines = output.trim().split('\n').filter(line => occupiesIpv4Loopback(line, port));
  if (!lines.length) return [];
  if (lines.some(line => !/pid=\d+/.test(line))) {
    throw new Error(`Cannot identify every listener on port ${port}; no processes were stopped.`);
  }
  return [...new Set(lines.flatMap(line => [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]))))];
}

function occupiesIpv4Loopback(line, port) {
  return line.includes(`127.0.0.1:${port}`) || line.includes(`0.0.0.0:${port}`) || line.includes(`[::]:${port}`) || new RegExp(`\\s\\*:${port}\\s`).test(line);
}

async function isFree(port) {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? done(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}


export async function cleanPort(target) {
  const port = ports[target];
  if (!port) throw new Error('Usage: node scripts/dev-ports.mjs <web|api|docs>');

  await releaseOwned(port, target);
  for (const extra of alsoFree[target] || []) await releaseOwned(extra, target, true);
}

async function releaseOwned(port, target, ignoreUnknown = false) {
  if (await isFree(port)) return;
  if (process.platform !== 'linux') {
    throw new Error(`Port ${port} is occupied. Automatic ownership checks require Linux; stop the old development process manually.`);
  }
  const listeners = listeningPids(port);
  const foreign = [];
  const killPids = [...new Set(listeners.map(pid => {
    const info = inspect(pid);
    if (!info || pid === process.pid || !ownsProcess(info, target)) {
      foreign.push(info ? `PID ${pid} (${info.cwd})` : `PID ${pid}`);
      return null;
    }
    return reclaimPid(pid, info, target);
  }))];
  if (!killPids.length || killPids.some(pid => pid == null)) {
    if (ignoreUnknown) return;
    const who = foreign.length ? ` (${foreign.join(', ')})` : '';
    throw new Error(`Port ${port} belongs to an unknown or unrelated process${who}; it was preserved. Stop it manually before retrying.`);
  }

  const owners = killPids.map(pid => ({ pid, info: inspect(pid) }));
  if (owners.some(({ info }) => !info || !ownsProcess(info, target))) {
    if (ignoreUnknown) return;
    throw new Error(`Port ${port} belongs to an unknown or unrelated process; it was preserved. Stop it manually before retrying.`);
  }
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
