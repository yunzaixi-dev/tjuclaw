#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, 'docs/content/docs/index.md');
const legacyPath = path.join(repoRoot, 'docs/content/docs/index.mdx');
const targetDesignPath = path.join(repoRoot, 'DESIGN.md');
const targetReadmePath = path.join(repoRoot, 'README.md');

const resolvedSourcePath = fs.existsSync(sourcePath) ? sourcePath : legacyPath;

if (!fs.existsSync(resolvedSourcePath)) {
  console.error(`Error: Source file not found at ${sourcePath} or ${legacyPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(resolvedSourcePath, 'utf8');

// Strip YAML frontmatter
const body = raw.replace(/^---[\s\S]*?---\n*/, '').trimStart();

// 1. 生成 DESIGN.md（附带克制的评委与读者指引提示）
const designHeader = `<!-- AUTO-GENERATED from docs/content/docs/index.md. DO NOT EDIT DIRECTLY. -->
<!-- Run \`task docs:sync\` or \`task docs:design\` to regenerate. -->

> **提示**：关于 TJUClaw 的完整系统设计、数据管道、沙箱安全、原生 CLI 与跨平台客户端实现等详细技术细节，建议访问官方文档站查阅：[https://tjuclaw.cloud/](https://tjuclaw.cloud/)（兼容镜像：[https://wiki.tjuclaw.cloud/](https://wiki.tjuclaw.cloud/)）。

`;

fs.writeFileSync(targetDesignPath, designHeader + body, 'utf8');
console.log(`Successfully synced ${targetDesignPath} from ${path.relative(repoRoot, resolvedSourcePath)}`);

// 2. 生成 README.md（同步 index 首页内容，附带克制的在线文档与仓库导航提示）
const readmeHeader = `<!-- AUTO-GENERATED from docs/content/docs/index.md. DO NOT EDIT DIRECTLY. -->
<!-- Run \`task docs:sync\` or \`task docs:design\` to regenerate. -->

> **提示**：本文档与官方文档站首页保持同步。如需浏览完整开发手册、API 规范与技术长文专栏，请访问：[https://tjuclaw.cloud/](https://tjuclaw.cloud/)。

`;

fs.writeFileSync(targetReadmePath, readmeHeader + body, 'utf8');
console.log(`Successfully synced ${targetReadmePath} from ${path.relative(repoRoot, resolvedSourcePath)}`);
