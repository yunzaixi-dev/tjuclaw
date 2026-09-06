import { spawnSync } from 'node:child_process';

// Separate project, ports and identities from the interactive development stack.
const args = ['compose', '-p', 'tjuclaw-auth-test', '-f', 'ops/auth/compose.yaml'];
const env = {
  ...process.env, AUTH_BROWSER_URL: 'http://127.0.0.1:1423',
  AUTH_KRATOS_PORT: '14434', AUTH_MAIL_PORT: '18026',
};
const run = (...command) => spawnSync('docker', [...args, ...command], { env, stdio: 'inherit' });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  run('down');
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (run('up', '--detach').status !== 0) { run('down'); process.exit(1); }
setInterval(() => {}, 1000);
