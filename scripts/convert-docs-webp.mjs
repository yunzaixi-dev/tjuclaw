#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const docsDir = path.join(repoRoot, 'docs');
const contentDocsDir = path.join(docsDir, 'content/docs');

// Detect available conversion engine
function getConversionCommand() {
  try {
    execFileSync('which', ['cwebp'], { stdio: 'ignore' });
    return 'cwebp';
  } catch {
    try {
      execFileSync('python3', ['-c', 'import PIL.Image'], { stdio: 'ignore' });
      return 'pil';
    } catch {
      try {
        execFileSync('which', ['ffmpeg'], { stdio: 'ignore' });
        return 'ffmpeg';
      } catch {
        throw new Error('No supported image converter found (requires cwebp, python3-pil, or ffmpeg).');
      }
    }
  }
}

const engine = getConversionCommand();
console.log(`Using conversion engine: ${engine}`);

function convertToWebp(sourcePath, targetPath) {
  if (engine === 'cwebp') {
    execFileSync('cwebp', ['-q', '85', sourcePath, '-o', targetPath], { stdio: 'ignore' });
  } else if (engine === 'pil') {
    const pythonScript = `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
    im.save(sys.argv[2], 'WEBP', quality=85, method=6)
else:
    im.convert('RGB').save(sys.argv[2], 'WEBP', quality=85, method=6)
`;
    execFileSync('python3', ['-c', pythonScript, sourcePath, targetPath], { stdio: 'ignore' });
  } else if (engine === 'ffmpeg') {
    execFileSync('ffmpeg', ['-y', '-i', sourcePath, '-c:v', 'libwebp', '-q:v', '85', targetPath], { stdio: 'ignore' });
  }
}

// Recursive directory scanner for images
function findImages(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findImages(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.png', '.jpg', '.jpeg'].includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

const targetScanDirs = [
  path.join(docsDir, 'public'),
  path.join(contentDocsDir, 'blog/images'),
  path.join(repoRoot, 'screenshots')
];

const convertedMap = new Map(); // originalFileName -> webpFileName

for (const dir of targetScanDirs) {
  const imageFiles = findImages(dir);
  for (const srcPath of imageFiles) {
    const ext = path.extname(srcPath);
    const dirName = path.dirname(srcPath);
    const baseName = path.basename(srcPath, ext);
    const webpName = `${baseName}.webp`;
    const dstPath = path.join(dirName, webpName);

    if (!fs.existsSync(dstPath) || fs.statSync(dstPath).mtimeMs < fs.statSync(srcPath).mtimeMs) {
      console.log(`Converting ${path.relative(repoRoot, srcPath)} -> ${webpName}...`);
      convertToWebp(srcPath, dstPath);
    }
    convertedMap.set(path.basename(srcPath), webpName);
  }
}

// 2. Scan and update Markdown files in docs/content/docs/
function updateMarkdownFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      updateMarkdownFiles(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let changed = false;

      for (const [orig, webp] of convertedMap.entries()) {
        const regex = new RegExp(`(?<=[(\\/]|^)${orig.replace('.', '\\.')}(?=[)\\s"\']|$)`, 'g');
        if (regex.test(content)) {
          content = content.replace(regex, webp);
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`Updated image references in ${path.relative(repoRoot, fullPath)}`);
      }
    }
  }
}

if (convertedMap.size > 0) {
  updateMarkdownFiles(contentDocsDir);
}

console.log('Image WebP conversion and markdown sync complete.');
