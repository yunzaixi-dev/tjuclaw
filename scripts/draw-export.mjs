#!/usr/bin/env node
// Render architecture diagrams with the project's Excalidraw board (draw/).
// Each docs/diagrams/<name>.json spec lists boxes and arrows; the script opens
// the running `task draw:dev` board in Chromium, converts the spec with
// Excalidraw's skeleton API and writes docs/content/docs/blog/images/<name>.webp
// plus an editable <name>.excalidraw scene beside the spec.
//
//   task draw:dev &    # loopback 5175
//   node scripts/draw-export.mjs [name ...]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(join(root, 'frontend', 'package.json'));
const { chromium } = require('@playwright/test');

const specs = join(root, 'docs', 'diagrams');
const images = join(root, 'docs', 'content', 'docs', 'blog', 'images');
const board = process.env.DRAW_URL ?? 'http://127.0.0.1:5175/';

const palette = {
  blue: ['#1e3a8a', '#dbeafe'],
  green: ['#166534', '#dcfce7'],
  amber: ['#92400e', '#fef3c7'],
  rose: ['#9f1239', '#ffe4e6'],
  violet: ['#5b21b6', '#ede9fe'],
  slate: ['#334155', '#f1f5f9'],
  zone: ['#94a3b8', 'transparent'],
};

// Boxes become labelled rectangles (zones are dashed, unlabelled frames with a
// caption); arrows bind to box ids so they stay attached when edited.
function skeleton(spec) {
  const elements = [];
  for (const zone of spec.zones ?? []) {
    elements.push({
      type: 'rectangle', x: zone.x, y: zone.y, width: zone.w, height: zone.h,
      strokeColor: palette.zone[0], backgroundColor: 'transparent', strokeStyle: 'dashed',
      roughness: 0, roundness: { type: 3 }, strokeWidth: 1,
    });
    elements.push({
      type: 'text', x: zone.x + 16, y: zone.y + 10, text: zone.label, fontSize: 18,
      strokeColor: '#475569', fontFamily: 5,
    });
  }
  for (const box of spec.boxes) {
    const [stroke, fill] = palette[box.color ?? 'slate'];
    elements.push({
      type: box.shape ?? 'rectangle', id: box.id, x: box.x, y: box.y,
      width: box.w ?? 220, height: box.h ?? 70,
      strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid',
      roughness: 0, roundness: { type: 3 }, strokeWidth: 2,
      label: { text: box.text, fontSize: box.fontSize ?? 18, fontFamily: 5, strokeColor: stroke },
    });
  }
  for (const edge of spec.edges) {
    const from = spec.boxes.find(box => box.id === edge.from);
    const to = spec.boxes.find(box => box.id === edge.to);
    if (!from || !to) throw new Error(`${spec.name}: unknown edge ${edge.from} -> ${edge.to}`);
    // Start and end on the box borders (with a small gap), not the centres.
    const center = box => [box.x + (box.w ?? 220) / 2, box.y + (box.h ?? 70) / 2];
    const border = (box, dx, dy) => {
      const t = Math.min((box.w ?? 220) / 2 / Math.abs(dx || 1e-9), (box.h ?? 70) / 2 / Math.abs(dy || 1e-9));
      const length = Math.hypot(dx, dy);
      return [dx * t + (dx / length) * 8, dy * t + (dy / length) * 8];
    };
    const [cx1, cy1] = center(from);
    const [cx2, cy2] = center(to);
    const [ox1, oy1] = border(from, cx2 - cx1, cy2 - cy1);
    const [ox2, oy2] = border(to, cx1 - cx2, cy1 - cy2);
    const [x1, y1, x2, y2] = [cx1 + ox1, cy1 + oy1, cx2 + ox2, cy2 + oy2];
    elements.push({
      type: 'arrow', x: x1, y: y1, width: x2 - x1, height: y2 - y1,
      points: [[0, 0], [x2 - x1, y2 - y1]],

      strokeColor: edge.muted ? '#94a3b8' : '#475569', strokeWidth: 2, roughness: 0,
      strokeStyle: edge.dashed ? 'dashed' : 'solid',
      ...(edge.label ? { label: { text: edge.label, fontSize: 15, fontFamily: 5 } } : {}),
    });
  }
  if (spec.title) {
    elements.push({ type: 'text', x: spec.titleX ?? 40, y: spec.titleY ?? -60, text: spec.title, fontSize: 28, fontFamily: 5, strokeColor: '#0f172a' });
  }
  return elements;
}

const wanted = new Set(process.argv.slice(2));
const files = readdirSync(specs).filter(file => file.endsWith('.json') && (!wanted.size || wanted.has(basename(file, '.json'))));
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
const page = await browser.newPage();
await page.goto(board);
await page.waitForSelector('.excalidraw');
for (const file of files) {
  const spec = JSON.parse(readFileSync(join(specs, file), 'utf8'));
  const result = await page.evaluate(async skeletonElements => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('@excalidraw_excalidraw.js'));
    if (!url) throw new Error('Excalidraw module not loaded by the board');
    const lib = await import(url);
    await document.fonts.ready;
    const elements = lib.convertToExcalidrawElements(skeletonElements, { regenerateIds: false });
    const blob = await lib.exportToBlob({
      elements, files: null, mimeType: 'image/webp', quality: 0.92, exportPadding: 32,
      appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportScale: 2, exportWithDarkMode: false },
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return { image: btoa(binary), scene: JSON.stringify({ type: 'excalidraw', version: 2, source: 'tjuclaw-draw', elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }, null, 1) };
  }, skeleton(spec));
  const name = basename(file, '.json');
  writeFileSync(join(images, `${name}.webp`), Buffer.from(result.image, 'base64'));
  writeFileSync(join(specs, `${name}.excalidraw`), result.scene + '\n');
  console.log(`${name}.webp`);
}
await browser.close();
