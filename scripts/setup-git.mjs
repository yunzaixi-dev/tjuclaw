import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
let existing;
try {
  existing = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (error) {
  if (error.status !== 1) throw error;
}
if (existing && existing !== '.githooks') {
  throw new Error(`Existing hooksPath ${existing}; integrate it manually instead of overwriting.`);
}
for (const hook of ['pre-commit', 'commit-msg']) {
  chmodSync(`${root}/.githooks/${hook}`, 0o755);
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root });
console.log('Local Git hooks enabled. No files staged or committed.');
