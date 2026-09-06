import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = join(root, 'private/audit');
const results = join(root, 'test-results/auth');
const report = JSON.parse(await readFile(join(results, 'report.json'), 'utf8'));
assert.ok(report.stats.expected > 0 && !report.stats.unexpected && !report.stats.skipped
  && !report.stats.flaky && !report.errors.length, 'Only a fully passing auth run can be imported');
const config = JSON.parse(await readFile(join(base, 'auth-config.json'), 'utf8'));
const files = await readdir(results, { recursive: true });
const run = `run-${Date.now()}`;
const directory = join(base, 'runtime/auth', run);
await mkdir(directory, { recursive: true });
let count = 0;
for (const state of config.states) {
  assert.match(state.id, /^[a-z-]+$/);
  state.captures = {};
  for (const viewport of ['compact', 'phone', 'tablet', 'desktop']) {
    for (const theme of ['light', 'dark']) {
      const name = `audit-${state.id}-${viewport}-${theme}`;
      const matches = files.filter(file => file.endsWith(`/${name}.json`));
      assert.equal(matches.length, 1, `Missing or ambiguous capture: ${name}`);
      const source = resolve(results, matches[0]);
      const metadata = JSON.parse(await readFile(source, 'utf8'));
      assert.equal(metadata.state, state.id);
      assert.equal(metadata.evidence, state.evidence);
      assert.ok(Date.parse(metadata.capturedAt) >= Date.parse(report.stats.startTime));
      const target = `${state.id}-${viewport}-${theme}.png`;
      await copyFile(source.replace(/\.json$/, '.png'), join(directory, target));
      state.captures[`${viewport}-${theme}`] = { ...metadata, file: `runtime/auth/${run}/${target}` };
      count++;
    }
  }
}
const manifest = { ...config, generatedAt: new Date().toISOString(),
  run: { passed: report.stats.expected, duration: report.stats.duration, startedAt: report.stats.startTime } };
const temporary = join(base, `auth-manifest.${run}.tmp`);
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, join(base, 'auth-manifest.json'));
console.log(`Imported ${count} real browser captures for ${config.states.length} auth states into private local evidence.`);
