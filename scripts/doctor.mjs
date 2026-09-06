import { spawnSync } from 'node:child_process';

let failed = false;
for (const [command, args] of [
  ['node', ['--version']], ['pnpm', ['--version']], ['task', ['--version']],
  ['go', ['version']], ['cargo', ['--version']], ['docker', ['compose', 'version']],
]) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const ok = result.status === 0;
  console.log(`${ok ? 'OK' : 'MISSING'} ${command}: ${ok ? result.stdout.trim() : 'install this tool before using its tasks'}`);
  failed ||= !ok;
}
console.log('Native targets: run task native:info. Android also needs JAVA_HOME, ANDROID_HOME and NDK_HOME.');
process.exitCode = failed ? 1 : 0;
