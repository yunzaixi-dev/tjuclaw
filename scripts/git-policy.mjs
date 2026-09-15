import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const emojis = {
  feat: '\u2728', fix: '\u{1F41B}', docs: '\u{1F4DD}',
  refactor: '\u267B\uFE0F', perf: '\u26A1', test: '\u2705',
  chore: '\u{1F527}', ci: '\u{1F477}', build: '\u{1F680}', revert: '\u23EA',
};
const number = '(?:0|[1-9][0-9]*)';
const versionPattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-(?:alpha|beta|rc)\\.${number})?$`);
const subjectPattern = /^(\S+) \[v([^\]]+)\] ([a-z]+)(?:\([a-z0-9][a-z0-9/-]*\))?!?: (\S.*)$/u;

export function checkMessage(message, version) {
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    throw new Error('package.json version must be MAJOR.MINOR.PATCH[-alpha.N|-beta.N|-rc.N].');
  }
  const subject = message.split(/\r?\n/, 1)[0];
  const match = subject.match(subjectPattern);
  if (!match || !Object.hasOwn(emojis, match[3]) || emojis[match[3]] !== match[1]) {
    throw new Error('Expected matching EMOJI [vVERSION] type(scope): summary; see CONTRIBUTING.md.');
  }
  if (match[2] !== version) throw new Error(`Commit version must match staged package.json: v${version}.`);
  if ([...subject].length > 100 || subject !== subject.trim()) {
    throw new Error('Commit subject must be at most 100 code points with no outer whitespace.');
  }
}

export function isPrivatePath(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  return ['CONTEXT.md', 'KEY_LINKS.md', 'content/docs/06-ui-reference.mdx'].includes(path)
    || /^(?:docs\/)?content\/docs\/0[1-7]-.*\.mdx$/.test(path)
    || path === 'ops/container-inventory.md'
    || /^mobbin.*\.zip$/i.test(name)
    || /^Grok Bot.*\.zip$/i.test(name)
    || ['frontend/PRODUCT.md', 'frontend/DESIGN.md'].includes(path)
    || path.startsWith('frontend/public/audits/')
    || /^scripts\/.*intelligence/.test(path)
    || /^scripts\/.*(?:simulator|corpus)/i.test(path)
    || path === 'scripts/collect-public-tju-data.mjs'
    || ['private/', 'research/', 'public/ui-reference/', 'docs/public/ui-reference/', 'ops/local/'].some((prefix) => path.startsWith(prefix))
    || name.includes('.private.')
    || (name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example')))
    || /\.(?:key|pem|tfstate)(?:\.|$)/.test(name)
    || /\.(?:sqlite3?|db|dump|sql\.gz)$/.test(name)
    || /\.(?:jks|keystore|p12|pfx)$/.test(name)
    || name === 'local.properties'
    || ['kubeconfig', 'talosconfig'].includes(name)
    || parts.includes('.terraform');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function checkIndex() {
  git(['diff', '--cached', '--check']);
  const blocked = git(['ls-files', '-z']).split('\0').filter(Boolean).filter(isPrivatePath);
  if (blocked.length) {
    throw new Error(`Private paths present in the Git index:\n${blocked.map((path) => JSON.stringify(path)).join('\n')}\nUnstage them without deleting local files.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (command === 'check-index') {
      checkIndex();
    } else if (command === 'commit-msg' && process.argv[3]) {
      // The index is the commit's source of truth, including during the first commit.
      const { version } = JSON.parse(git(['show', ':package.json']));
      checkMessage(readFileSync(process.argv[3], 'utf8'), version);
    } else {
      throw new Error('Usage: git-policy.mjs check-index | commit-msg <message-file>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
