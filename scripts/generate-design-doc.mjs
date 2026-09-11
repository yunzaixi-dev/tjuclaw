#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceMdxPath = path.join(repoRoot, 'docs/content/docs/index.mdx');
const targetDesignPath = path.join(repoRoot, 'DESIGN.md');

if (!fs.existsSync(sourceMdxPath)) {
  console.error(`Error: Source file not found at ${sourceMdxPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(sourceMdxPath, 'utf8');

// Strip YAML frontmatter
let content = raw.replace(/^---[\s\S]*?---\n*/, '');

// Prepend auto-generated header notice and official docs link
const header = `<!-- AUTO-GENERATED from docs/content/docs/index.mdx. DO NOT EDIT DIRECTLY. -->
<!-- Run \`task docs:design\` to regenerate. -->

> **提示**：本文档同步自 [tjuclaw.cloud](https://tjuclaw.cloud/) 官方文档。如需保持最佳阅读体验，请访问官方网站：[https://tjuclaw.cloud/](https://tjuclaw.cloud/)

`;

const finalDoc = header + content.trimStart();

fs.writeFileSync(targetDesignPath, finalDoc, 'utf8');
console.log(`Successfully generated ${targetDesignPath} from docs/content/docs/index.mdx`);
