#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, 'docs/content/docs/index.md');
const legacyPath = path.join(repoRoot, 'docs/content/docs/index.mdx');
const targetDesignPath = path.join(repoRoot, 'DESIGN.md');
const targetReadmePath = path.join(repoRoot, 'README.md');

const designHeader = `<!-- AUTO-GENERATED from docs/content/docs/index.md. DO NOT EDIT DIRECTLY. -->
<!-- Run \`task docs:sync\` or \`task docs:design\` to regenerate. -->

> **提示**：关于 TJUClaw 的完整系统设计、数据管道、沙箱安全、原生 CLI 与跨平台客户端实现等详细技术细节，建议访问官方文档站查阅：[https://tjuclaw.cloud/](https://tjuclaw.cloud/)（兼容镜像：[https://wiki.tjuclaw.cloud/](https://wiki.tjuclaw.cloud/)）。

`;

const readmeHeader = `<!-- AUTO-GENERATED from docs/content/docs/index.md. DO NOT EDIT DIRECTLY. -->
<!-- Run \`task docs:sync\` or \`task docs:design\` to regenerate. -->

> **提示**：本文档与官方文档站首页保持同步。如需浏览完整开发手册、API 规范与技术长文专栏，请访问：[https://tjuclaw.cloud/](https://tjuclaw.cloud/)。

`;

export function renderDocuments(raw) {
  const body = raw.replace(/^---[\s\S]*?---\n*/, '').trimStart();
  return {
    design: designHeader + body,
    readme: readmeHeader + body,
  };
}

function readSource() {
  const resolvedSourcePath = fs.existsSync(sourcePath) ? sourcePath : legacyPath;
  if (!fs.existsSync(resolvedSourcePath)) {
    throw new Error(`Source file not found at ${sourcePath} or ${legacyPath}`);
  }
  return { path: resolvedSourcePath, raw: fs.readFileSync(resolvedSourcePath, 'utf8') };
}

function readIndex(pathname) {
  try {
    return execFileSync('git', ['show', `:${pathname}`], { cwd: repoRoot, encoding: 'utf8' });
  } catch (error) {
    if (error.status !== 128) throw error;
    return fs.readFileSync(path.join(repoRoot, pathname), 'utf8');
  }
}

function readRequiredIndex(pathname) {
  try {
    return execFileSync('git', ['show', `:${pathname}`], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    throw new Error(`${pathname} must be staged with the homepage changes. Run task docs:sync, then stage the generated files.`);
  }
}

function checkDocuments(documents, readTarget) {
  const mismatches = [];
  for (const [pathname, expected] of [['DESIGN.md', documents.design], ['README.md', documents.readme]]) {
    let actual;
    try {
      actual = readTarget(pathname);
    } catch {
      mismatches.push(pathname);
      continue;
    }
    if (actual !== expected) mismatches.push(pathname);
  }
  if (mismatches.length) {
    throw new Error(`Generated homepage documents are out of sync: ${mismatches.join(', ')}. Run task docs:sync, then stage the generated files.`);
  }
}

function main() {
  const { path: resolvedSourcePath, raw } = readSource();
  const documents = renderDocuments(raw);
  if (process.argv[2] === '--check-index') {
    const stagedSource = readIndex(path.relative(repoRoot, resolvedSourcePath));
    checkDocuments(renderDocuments(stagedSource), readRequiredIndex);
    return;
  }
  if (process.argv[2] === '--check') {
    checkDocuments(documents, (pathname) => fs.readFileSync(path.join(repoRoot, pathname), 'utf8'));
    return;
  }
  fs.writeFileSync(targetDesignPath, documents.design, 'utf8');
  console.log(`Successfully synced ${targetDesignPath} from ${path.relative(repoRoot, resolvedSourcePath)}`);
  fs.writeFileSync(targetReadmePath, documents.readme, 'utf8');
  console.log(`Successfully synced ${targetReadmePath} from ${path.relative(repoRoot, resolvedSourcePath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
