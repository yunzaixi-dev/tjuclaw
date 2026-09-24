#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'backend/openapi/tjuclaw.yaml');
const targetPath = path.join(repoRoot, 'docs/content/openapi/tjuclaw.yaml');
const routePattern = /mux\.HandleFunc\(\s*"((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+[^"]+)"/g;
const routeFiles = [
  path.join(repoRoot, 'backend/cmd'),
  path.join(repoRoot, 'backend/internal'),
];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(pathname);
    return entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go') ? [pathname] : [];
  });
}

function readSource() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`OpenAPI source not found: ${path.relative(repoRoot, sourcePath)}`);
  }
  const text = fs.readFileSync(sourcePath, 'utf8');
  const document = parse(text);
  if (!document || document.openapi !== '3.1.0') {
    throw new Error('OpenAPI source must declare openapi: 3.1.0');
  }
  if (!document.info?.title || !document.info?.version) {
    throw new Error('OpenAPI source must contain info.title and info.version');
  }
  if (!document.paths || typeof document.paths !== 'object') {
    throw new Error('OpenAPI source must contain paths');
  }
  return { text, document };
}

function implementedRoutes() {
  const routes = new Set();
  for (const filename of routeFiles.flatMap(walk)) {
    const text = fs.readFileSync(filename, 'utf8');
    for (const match of text.matchAll(routePattern)) routes.add(match[1]);
  }
  return routes;
}

function documentedRoutes(document) {
  const routes = new Set();
  for (const [pathname, item] of Object.entries(document.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (item?.[method]) routes.add(`${method.toUpperCase()} ${pathname}`);
    }
  }
  return routes;
}

function validate(document) {
  const missing = [...implementedRoutes()].filter((route) => !documentedRoutes(document).has(route)).sort();
  if (missing.length) {
    throw new Error(`OpenAPI is missing implemented backend routes:\n${missing.map((route) => `- ${route}`).join('\n')}`);
  }

  const operationIds = new Map();
  for (const [pathname, item] of Object.entries(document.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = item?.[method];
      if (!operation) continue;
      if (!operation.operationId) throw new Error(`Missing operationId for ${method.toUpperCase()} ${pathname}`);
      const previous = operationIds.get(operation.operationId);
      if (previous) throw new Error(`Duplicate operationId ${operation.operationId}: ${previous} and ${method.toUpperCase()} ${pathname}`);
      operationIds.set(operation.operationId, `${method.toUpperCase()} ${pathname}`);
    }
  }
}

export function syncApiDocs({ check = false } = {}) {
  const { text, document } = readSource();
  validate(document);
  const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
  if (current === text) return { changed: false, sourcePath, targetPath };
  if (check) {
    throw new Error(`Documentation OpenAPI is out of sync: ${path.relative(repoRoot, targetPath)}. Run task api:docs.`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, text, 'utf8');
  return { changed: true, sourcePath, targetPath };
}

function main() {
  const result = syncApiDocs({ check: process.argv.includes('--check') });
  const action = result.changed ? 'Synced' : 'Already synchronized';
  console.log(`${action} ${path.relative(repoRoot, result.targetPath)} from ${path.relative(repoRoot, result.sourcePath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
