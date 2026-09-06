import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'tjuclaw-context-'));
const allowed = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'frontend/package.json', 'frontend/index.html', 'frontend/app-icon.svg',
  'frontend/tsconfig.json', 'frontend/vite.config.ts', 'frontend/audit-server.ts', 'docs/package.json',
  'ops/images/web.Dockerfile', 'ops/images/nginx.conf',
]);

try {
  const result = spawnSync('docker', [
    'build', '--quiet', '--file', '-', '--output', `type=local,dest=${output}`, '.',
  ], {
    cwd: root, input: 'FROM scratch\nCOPY . /\n', encoding: 'utf8',
    timeout: 120000,
  });
  if (result.status !== 0) throw new Error(`Docker context export failed: ${result.error?.message || result.stderr}`);
  const files = readdirSync(output, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(output.length + 1).replaceAll('\\', '/'));
  const unexpected = files.filter((path) => !allowed.has(path) && !path.startsWith('frontend/src/'));
  assert.deepEqual(unexpected, [], 'Unexpected files in actual Docker context');
  assert.ok(files.includes('frontend/src/main.tsx'), 'Client source missing from context');
  assert.ok(files.includes('docs/package.json'), 'Workspace manifest missing from context');
  assert.ok(files.every((path) => !/(?:node_modules|target|\.next|\.env|\.private\.)/.test(path)));
  console.log(`Docker context verified: ${files.length} approved source/config files, no caches or private directories.`);
} finally {
  rmSync(output, { recursive: true, force: true });
}
