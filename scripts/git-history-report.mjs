import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const DEFAULT_KEY_THRESHOLD = 7;
const DEFAULT_KEY_LIMIT = 80;

const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.mjs', '.cjs', '.kt', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx',
  '.vue', '.svelte', '.css', '.scss', '.less', '.html', '.sql', '.sh',
]);
const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.toml', '.ini', '.conf', '.yml', '.yaml', '.xml',
  '.env', '.lock',
]);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const KEYWORD_GROUPS = [
  ['auth', /\b(auth|kratos|zitadel|cap|otp|login|password)\b/i],
  ['workspace', /\b(workspace|knowledge|library|entry|session|agent)\b/i],
  ['execution', /\b(crawler|ocr|weknora|pi|sandbox|forgejo|r2|storage)\b/i],
  ['delivery', /\b(github|gitlab|ci|deploy|release|mirror|actions)\b/i],
  ['product', /\b(tldraw|excalidraw|slides|brand|frontend|client|api)\b/i],
];
const TYPE_WEIGHTS = new Map([
  ['feat', 6],
  ['refactor', 5],
  ['perf', 4],
  ['build', 4],
  ['ci', 3],
  ['test', 2],
  ['fix', 2],
  ['revert', 2],
  ['docs', 1],
  ['chore', 1],
]);

function runGit(args, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const options = {
    ref: 'release',
    outputDir: null,
    keyThreshold: DEFAULT_KEY_THRESHOLD,
    keyLimit: DEFAULT_KEY_LIMIT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--ref') {
      options.ref = argv[++index];
      continue;
    }
    if (arg === '--output-dir') {
      options.outputDir = argv[++index];
      continue;
    }
    if (arg === '--key-threshold') {
      options.keyThreshold = Number(argv[++index]);
      continue;
    }
    if (arg === '--key-limit') {
      options.keyLimit = Number(argv[++index]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.ref) throw new Error('--ref requires a Git ref');
  if (!Number.isInteger(options.keyThreshold) || options.keyThreshold < 1) {
    throw new Error('--key-threshold must be a positive integer');
  }
  if (!Number.isInteger(options.keyLimit) || options.keyLimit < 1) {
    throw new Error('--key-limit must be a positive integer');
  }
  return options;
}

function usage() {
  return `Usage:
  node scripts/git-history-report.mjs [options]

Options:
  --ref <ref>                 Root ref to analyze (default: release)
  --output-dir <directory>    Write JSON, NDJSON and Markdown reports
  --key-threshold <number>    Minimum score for a key commit (default: ${DEFAULT_KEY_THRESHOLD})
  --key-limit <number>        Maximum key commits in the Markdown summary (default: ${DEFAULT_KEY_LIMIT})
`;
}

function fileExtension(path) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

export function classifyPath(path) {
  const normalized = path.toLowerCase();
  if ((normalized === '.git' || normalized.startsWith('.git/')) || normalized.includes('/node_modules/')) return 'other';
  const extension = fileExtension(path);
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (CONFIG_EXTENSIONS.has(extension) || normalized.startsWith('.github/')) return 'config';
  if (DOC_EXTENSIONS.has(extension)) return 'docs';
  return 'other';
}

function parseNumstatLine(line) {
  const fields = line.split('\t');
  if (fields.length < 3) return null;
  const [addedRaw, deletedRaw, ...pathFields] = fields;
  const path = pathFields.join('\t');
  const added = /^\d+$/.test(addedRaw) ? Number(addedRaw) : null;
  const deleted = /^\d+$/.test(deletedRaw) ? Number(deletedRaw) : null;
  if (added === null || deleted === null || !path) return null;
  return {
    path,
    added,
    deleted,
    category: classifyPath(path.includes(' => ') ? path.split(' => ').at(-1) : path),
  };
}

export function parseNumstat(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseNumstatLine)
    .filter(Boolean);
}

function emptyTotals() {
  return {
    files: 0,
    added: 0,
    deleted: 0,
    net: 0,
  };
}

function addStat(totals, stat) {
  totals.files += 1;
  totals.added += stat.added;
  totals.deleted += stat.deleted;
  totals.net = totals.added - totals.deleted;
}

function summarizeStats(files) {
  const totals = {
    all: emptyTotals(),
    code: emptyTotals(),
    config: emptyTotals(),
    docs: emptyTotals(),
    other: emptyTotals(),
  };
  for (const file of files) {
    addStat(totals.all, file);
    addStat(totals[file.category], file);
  }
  return totals;
}

function mergeTotals(target, delta) {
  for (const category of Object.keys(target)) {
    for (const field of ['files', 'added', 'deleted']) {
      target[category][field] += delta[category][field];
    }
    target[category].net = target[category].added - target[category].deleted;
  }
}

function typeFromSubject(subject) {
  const match = subject.match(/\b(feat|fix|chore|docs|ci|perf|test|revert|refactor|build)(?:\([^)]*\))?:/i);
  return match ? match[1].toLowerCase() : 'other';
}

function versionFromSubject(subject) {
  return subject.match(/\[v([0-9]+\.[0-9]+\.[0-9]+)\]/i)?.[1] ?? null;
}

export function scoreCommit(commit, isFirst, isLast, threshold = DEFAULT_KEY_THRESHOLD) {
  const type = typeFromSubject(commit.subject);
  const keywordMatches = KEYWORD_GROUPS
    .filter(([, pattern]) => pattern.test(commit.subject))
    .map(([name]) => name);
  const codeChurn = commit.stats.code.added + commit.stats.code.deleted;
  const totalChurn = commit.stats.all.added + commit.stats.all.deleted;
  const reasons = [];
  let score = TYPE_WEIGHTS.get(type) ?? 0;

  if (type !== 'other') reasons.push(type);
  if (keywordMatches.length > 0) {
    score += keywordMatches.length * 2;
    reasons.push(...keywordMatches);
  }
  if (codeChurn >= 1000) {
    score += 4;
    reasons.push('large-code-change');
  } else if (codeChurn >= 300) {
    score += 2;
    reasons.push('code-change');
  }
  if (totalChurn >= 2000) {
    score += 2;
    reasons.push('large-change');
  }
  if (commit.topLevelPaths.length >= 3) {
    score += 1;
    reasons.push('cross-area');
  }
  if (isFirst) {
    score += 4;
    reasons.push('first-commit');
  }
  if (isLast) {
    score += 2;
    reasons.push('latest-commit');
  }

  return {
    ...commit,
    type,
    version: versionFromSubject(commit.subject),
    keyScore: score,
    isKey: score >= threshold,
    keyReason: [...new Set(reasons)],
  };
}

function topLevelPaths(files) {
  return [...new Set(files.map(({ path }) => path.split('/')[0]))].sort();
}

function commitList(cwd, ref) {
  const raw = runGit([
    'log',
    '--first-parent',
    '--reverse',
    '--format=%H%x1f%P%x1f%aI%x1f%cI%x1f%an%x1f%ae%x1f%s%x1e',
    ref,
  ], cwd);
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, authoredAt, committedAt, authorName, authorEmail, subject] = record.split('\x1f');
      return {
        sha: sha.trim(),
        shortSha: sha.slice(0, 12),
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        authoredAt,
        committedAt,
        authorName,
        authorEmail,
        subject,
      };
    });
}

function commitFiles(cwd, sha) {
  return parseNumstat(runGit([
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--numstat',
    '--find-renames',
    '--find-copies',
    '-r',
    sha,
  ], cwd));
}

function tagsBySha(cwd) {
  const map = new Map();
  const raw = runGit(['for-each-ref', '--format=%(objectname)%x1f%(refname:short)', 'refs/tags'], cwd);
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const [sha, tag] = line.split('\x1f');
    const tags = map.get(sha) ?? [];
    tags.push(tag);
    map.set(sha, tags);
  }
  return map;
}

function analyzeHistory({ label, cwd, ref, kind, keyThreshold }) {
  const commits = commitList(cwd, ref);
  const tags = tagsBySha(cwd);
  const cumulative = {
    all: emptyTotals(),
    code: emptyTotals(),
    config: emptyTotals(),
    docs: emptyTotals(),
    other: emptyTotals(),
  };

  const enriched = commits.map((commit, index) => {
    const files = commitFiles(cwd, commit.sha);
    const stats = summarizeStats(files);
    mergeTotals(cumulative, stats);
    const enrichedCommit = {
      ...commit,
      repository: label,
      kind,
      filesChanged: files.length,
      changedFiles: files,
      topLevelPaths: topLevelPaths(files),
      stats,
      cumulative: structuredClone(cumulative),
      tags: tags.get(commit.sha) ?? [],
    };
    return scoreCommit(
      enrichedCommit,
      index === 0,
      index === commits.length - 1,
      keyThreshold,
    );
  });

  const keyCommits = enriched
    .filter((commit) => commit.isKey)
    .sort((left, right) => right.keyScore - left.keyScore || left.committedAt.localeCompare(right.committedAt));

  return {
    label,
    kind,
    ref,
    commitCount: enriched.length,
    firstCommit: enriched[0] ?? null,
    lastCommit: enriched.at(-1) ?? null,
    totals: cumulative,
    commits: enriched,
    keyCommits,
  };
}

function trackedFiles(cwd) {
  return runGit(['ls-files', '--stage', '-z'], cwd)
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\d+)\s+\S+\s+\d+\t([\s\S]+)$/);
      return match && { mode: match[1], path: match[2] };
    })
    .filter((entry) => entry && entry.mode !== '160000')
    .map((entry) => entry.path);
}

function clocSnapshot(cwd) {
  const files = trackedFiles(cwd);
  if (files.length === 0) {
    return { files: 0, blank: 0, comment: 0, code: 0, languages: {} };
  }

  const listPath = join(tmpdir(), `tjuclaw-cloc-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  try {
    writeFileSync(listPath, `${files.join('\n')}\n`);
    const raw = execFileSync('cloc', [
      '--json',
      '--quiet',
      '--list-file',
      listPath,
    ], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw);
    const sum = parsed.SUM ?? {};
    const languages = Object.fromEntries(
      Object.entries(parsed)
        .filter(([name]) => !['header', 'SUM'].includes(name))
        .map(([name, value]) => [name, value]),
    );
    return {
      files: sum.nFiles ?? 0,
      blank: sum.blank ?? 0,
      comment: sum.comment ?? 0,
      code: sum.code ?? 0,
      languages,
    };
  } finally {
    rmSync(listPath, { force: true });
  }
}

function submodulePaths() {
  const raw = runGit(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/).at(-1));
}

function submoduleShaAt(ref, path) {
  const line = runGit(['ls-tree', ref, '--', path]).trim();
  return line.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1] ?? null;
}

function analyzeSubmodules(rootRef, keyThreshold) {
  return submodulePaths().map((path) => {
    const cwd = join(ROOT, path);
    const currentSha = runGit(['rev-parse', 'HEAD'], cwd).trim();
    const pinnedSha = submoduleShaAt(rootRef, path);
    const history = analyzeHistory({
      label: path,
      cwd,
      ref: 'HEAD',
      kind: 'submodule',
      keyThreshold,
    });
    return {
      ...history,
      path,
      currentSha,
      pinnedSha,
      dirty: Boolean(runGit(['status', '--short'], cwd).trim()),
      snapshot: clocSnapshot(cwd),
    };
  });
}

function buildMarkdown(report, keyLimit) {
  const lines = [
    `# Git 历史与代码量报告`,
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 根仓库 ref：\`${report.options.ref}\``,
    `- 说明：历史行数为 Git numstat 的累计增删；当前代码量为 Git 跟踪文件的 cloc 快照。`,
    '',
    '## 总览',
    '',
    `| 仓库 | 提交数 | 当前 cloc 代码行 | 历史代码增删 | 净变化 |`,
    '| --- | ---: | ---: | ---: | ---: |',
  ];

  for (const repository of [report.root, ...report.submodules]) {
    lines.push(
      `| ${repository.label} | ${repository.commitCount} | ${repository.snapshot.code.toLocaleString()} | +${repository.totals.code.added.toLocaleString()} / -${repository.totals.code.deleted.toLocaleString()} | ${repository.totals.code.net >= 0 ? '+' : ''}${repository.totals.code.net.toLocaleString()} |`,
    );
  }

  lines.push('', '## 根仓库关键提交', '');
  lines.push('| 日期 | SHA | 类型 | 分数 | 主题 |', '| --- | --- | --- | ---: | --- |');
  for (const commit of report.root.keyCommits.slice(0, keyLimit).sort((left, right) => left.committedAt.localeCompare(right.committedAt))) {
    lines.push(
      `| ${commit.committedAt.slice(0, 10)} | \`${commit.shortSha}\` | ${commit.type} | ${commit.keyScore} | ${commit.subject.replace(/\|/g, '\\|')} |`,
    );
  }

  lines.push('', '## 子模块关键提交', '');
  for (const repository of report.submodules) {
    lines.push(`### ${repository.label}`, '');
    for (const commit of repository.keyCommits.slice(0, Math.min(keyLimit, 20)).sort((left, right) => left.committedAt.localeCompare(right.committedAt))) {
      lines.push(`- ${commit.committedAt.slice(0, 10)} \`${commit.shortSha}\` ${commit.subject}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function writeReport(report, outputDir, keyLimit) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'git-history.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    join(outputDir, 'commits.ndjson'),
    `${report.allCommits.map((commit) => JSON.stringify(commit)).join('\n')}\n`,
  );
  writeFileSync(join(outputDir, 'git-history.md'), buildMarkdown(report, keyLimit));
}

function summarize(report) {
  const repositories = [report.root, ...report.submodules];
  console.log(`Git history report: ${report.options.ref}`);
  for (const repository of repositories) {
    console.log(
      `${repository.label}: ${repository.commitCount} commits, ${repository.snapshot.code.toLocaleString()} current cloc code lines, ${repository.totals.code.net >= 0 ? '+' : ''}${repository.totals.code.net.toLocaleString()} historical net code lines, ${repository.keyCommits.length} key commits`,
    );
  }
  if (report.outputDir) console.log(`Reports written to ${report.outputDir}`);
}

export function collectReport(options) {
  const rootHistory = analyzeHistory({
    label: 'root',
    cwd: ROOT,
    ref: options.ref,
    kind: 'root',
    keyThreshold: options.keyThreshold,
  });
  const root = {
    ...rootHistory,
    snapshot: clocSnapshot(ROOT),
  };
  const submodules = analyzeSubmodules(options.ref, options.keyThreshold);
  const allCommits = [root, ...submodules].flatMap((repository) => repository.commits);
  return {
    generatedAt: new Date().toISOString(),
    repositoryRoot: ROOT,
    options,
    root,
    submodules,
    allCommits,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const report = collectReport(options);
    if (options.outputDir) {
      writeReport(report, options.outputDir, options.keyLimit);
      report.outputDir = options.outputDir;
    }
    summarize(report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
