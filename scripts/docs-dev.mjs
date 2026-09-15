import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const ports = [3000];

function probePort(port, host, ipv6Only = false) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ port, host, exclusive: true, ipv6Only }, () => {
      server.close(resolve);
    });
  });
}

async function assertPortAvailable(port) {
  try {
    await probePort(port, '0.0.0.0');
    await probePort(port, '::', true);
  } catch (error) {
    if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') return;
    if (error.code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use; stop its owner or choose another port.`);
    }
    throw error;
  }
}

try {
  for (const port of ports) await assertPortAvailable(port);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const commands = [
  ['docs', 'pnpm', ['--dir', 'docs', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', '3000']],
];
const children = [];
let stopping = false;
let forceTimer;

function signalGroup(child, signal) {
  if (!child.pid) return;

  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(`Failed to send ${signal} to child group ${child.pid}: ${error.message}`);
  }
}

function shutdown(signal = 'SIGTERM', exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) signalGroup(child, signal);

  forceTimer = setTimeout(() => {
    for (const child of children) signalGroup(child, 'SIGKILL');
  }, 5000);
  forceTimer.unref();
}

for (const [name, command, args] of commands) {
  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    });
  } catch (error) {
    console.error(`Failed to start ${name}: ${error.message}`);
    shutdown('SIGTERM', 1);
    break;
  }

  children.push(child);
  child.once('error', (error) => {
    console.error(`Failed to start ${name}: ${error.message}`);
    shutdown('SIGTERM', 1);
  });
  child.once('exit', (code, signal) => {
    if (stopping) return;
    if (signal) console.error(`${name} exited with signal ${signal}`);
    else if (code !== 0) console.error(`${name} exited with code ${code}`);
    shutdown('SIGTERM', code || 1);
  });
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => shutdown(signal, exitCode));
}

process.once('exit', () => {
  if (forceTimer) clearTimeout(forceTimer);
  for (const child of children) signalGroup(child, 'SIGKILL');
});
