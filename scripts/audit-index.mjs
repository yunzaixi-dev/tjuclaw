import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const base = new URL('../private/audit/', import.meta.url);
const dataset = JSON.parse(await readFile(new URL('dataset.json', base), 'utf8'));
const batches = await readdir(new URL('batches/', base));
const metadata = (await Promise.all(batches.filter(name => /^\d{2}\.json$/.test(name))
  .map(name => readFile(new URL(`batches/${name}`, base), 'utf8').then(JSON.parse)))).flat();
assert.equal(metadata.length, dataset.expectedScreens, 'Every screenshot needs a completed description');
const files = await readdir(new URL('reference/', base));
const screens = await Promise.all(metadata.map(async item => {
  assert.ok(Number.isInteger(item.index) && item.index >= 0 && item.index < dataset.expectedScreens);
  assert.equal(item.id, `GB-${String(item.index).padStart(3, '0')}`);
  const file = files.find(name => name.endsWith(` ${item.index}.png`));
  assert.ok(file, `${item.id}: reference missing`);
  const data = await readFile(new URL(`reference/${file}`, base));
  const description = await readFile(new URL(`descriptions/${item.id}.md`, base), 'utf8');
  assert.ok(description.length >= 200, `${item.id}: description too short`);
  assert.ok(item.title && item.summary && item.category && Array.isArray(item.controls));
  return { ...item, file, width: data.readUInt32BE(16), height: data.readUInt32BE(20),
    transitions: item.transitions || [] };
}));
screens.sort((a, b) => a.index - b.index);
assert.equal(new Set(screens.map(item => item.id)).size, dataset.expectedScreens);
for (const screen of screens) {
  for (const edge of screen.transitions) assert.ok(screens.some(item => item.id === edge.to), 'Unknown transition target');
  for (const edge of screen.transitions) {
    assert.equal(edge.confidence, 'inferred', 'Static screenshots cannot verify navigation');
    assert.ok(typeof edge.action === 'string' && edge.action.length > 0);
  }
}
const journeys = JSON.parse(await readFile(new URL('journeys.json', base), 'utf8'));
for (const journey of journeys) {
  assert.ok(journey.nodes.every(id => screens.some(screen => screen.id === id)), 'Unknown journey node');
}
assert.equal(new Set(journeys.flatMap(journey => journey.nodes)).size, screens.length,
  'Every screenshot must appear in the journey inventory');
for (const screen of screens) {
  screen.stateCategory = screen.category;
  screen.category = journeys.find(journey => journey.nodes.includes(screen.id)).title;
}
await writeFile(new URL('manifest.json', base), JSON.stringify({ name: dataset.name, screens, journeys }, null, 2) + '\n');
console.log(`Indexed ${screens.length} images and descriptions; ${journeys.length} reviewed journey groups.`);
