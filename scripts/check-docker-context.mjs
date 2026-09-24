import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'tjuclaw-context-'));
const allowed = new Set([
  'frontend/package.json', 'frontend/index.html', 'frontend/app-icon.svg', 'frontend/app-icon.png', 'frontend/favicon.png',
  'frontend/tsconfig.json', 'frontend/vite.config.ts', 'frontend/audit-server.ts', 'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml',
  'ops/images/web.Dockerfile', 'ops/images/nginx.conf',
  'cli/go.mod', 'sandbox/go.mod', 'sandbox/profiles.example.json',
]);
const allowedPrefixes = [
  'frontend/src/',
  'cli/cmd/', 'cli/internal/', 'cli/skills/tjucli/',
  'sandbox/cmd/', 'sandbox/internal/', 'sandbox/image/',
];

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
  const unexpected = files.filter((path) =>
    !allowed.has(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix)));
  assert.deepEqual(unexpected, [], 'Unexpected files in actual Docker context');
  assert.ok(files.includes('frontend/src/main.tsx'), 'Client source missing from context');
  assert.ok(files.includes('frontend/pnpm-lock.yaml'), 'Client lockfile missing from context');
  assert.ok(files.every((path) => !/(?:node_modules|target|\.next|\.env|\.private\.)/.test(path)));
  console.log(`Docker context verified: ${files.length} approved source/config files, no caches or private directories.`);
} finally {
  rmSync(output, { recursive: true, force: true });
}
