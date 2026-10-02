// Selects the CI jobs a change needs. The base is the last successful CI run
// on the branch rather than the previous push, so a cancelled or failed run
// never hides a change. Anything unknown or unreadable runs everything.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const groups = ['web', 'docs', 'api', 'cli', 'crawler', 'ops', 'sandbox'];
const portable = ['web', 'docs', 'api', 'cli', 'crawler'];
const everything = () => Object.fromEntries(groups.map(group => [group, true]));

// First match wins. Submodules appear as their gitlink path. Repository
// tooling checks always run, so a rule lists only the extra groups.
const rules = [
  [/^frontend$/, ['web']],
  [/^backend$/, ['api']],
  [/^cli$/, ['cli', 'sandbox']],
  [/^crawler$/, ['crawler']],
  [/^sandbox$/, ['sandbox']],
  [/^ClaudeAnimationBase$/, []],
  [/^docs\//, ['docs']],
  [/^ops\/(auth|images)\//, ['ops', 'api']],
  // The real-auth regression runs locally (`task auth:test`), not in CI.
  [/^ops\/compose\.env\.example$/, []],
  [/^ops\/ci\//, []],
  [/^ops\//, ['ops']],
  [/^(compose\.yaml|\.dockerignore)$/, []],
  [/^scripts\/(auth|session-test-controller|local-sandbox|check-docker-context)/, []],
  [/^scripts\/deploy-release\./, ['ops']],
  [/^scripts\//, portable],
  [/^(draw|screenshots)\//, []],
  [/^[^/]+\.(md|pdf|docx|jpeg|png|webp)$/, []],
  [/^(LICENSE|LICENSE-DOCS|NOTICE|\.gitignore)$/, []],
];

export function plan(files) {
  if (!files) return everything();
  const selected = Object.fromEntries(groups.map(group => [group, false]));
  for (const file of files) {
    const rule = rules.find(([pattern]) => pattern.test(file));
    if (!rule) return everything();
    for (const group of rule[1]) selected[group] = true;
  }
  return selected;
}

// Returns the changed paths, or null when the whole pipeline must run.
export async function changedFiles(env, request) {
  const event = env.GITHUB_EVENT_NAME;
  if (event !== 'push' && event !== 'pull_request') return null;
  if (env.GITHUB_REF?.startsWith('refs/tags/') || Number(env.GITHUB_RUN_ATTEMPT) > 1) return null;
  const repository = env.GITHUB_REPOSITORY;
  let base = env.BASE_SHA;
  if (event === 'push') {
    const branch = encodeURIComponent(env.GITHUB_REF_NAME);
    const runs = await request(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=${branch}&status=success&per_page=1`);
    base = runs.workflow_runs?.[0]?.head_sha;
  }
  if (!base) return null;
  const compare = await request(`/repos/${repository}/compare/${base}...${env.HEAD_SHA || env.GITHUB_SHA}`);
  // The compare API lists at most 300 files; a full list cannot be told from a truncated one.
  if (!Array.isArray(compare.files) || compare.files.length >= 300) return null;
  return compare.files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
}

async function main() {
  const request = async path => {
    const response = await fetch(`https://api.github.com${path}`, { headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    } });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path.split('?')[0]}`);
    return response.json();
  };
  let files = null;
  try {
    files = await changedFiles(process.env, request);
  } catch (error) {
    console.log(`Could not read the change set (${error.message}); running everything`);
  }
  const selected = plan(files);
  console.log(files ? `${files.length} changed path(s) since the last successful run` : 'Full run');
  for (const group of groups) console.log(`${selected[group] ? 'run ' : 'skip'} ${group}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, groups.map(group => `${group}=${selected[group]}\n`).join(''));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
