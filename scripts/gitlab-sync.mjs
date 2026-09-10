import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const mirrorUrl = 'https://gitlab.tju.edu.cn/3023244020/agent2026-tjuclaw.git';

export function validateMirrorRef(ref) {
  if (ref !== 'refs/heads/release' && !/^refs\/tags\/v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(ref ?? '')) {
    throw new Error('Only release and version tags may be mirrored');
  }
  return ref;
}

export function syncSource(env = process.env, execute = execFileSync) {
  if (env.GITHUB_REPOSITORY !== 'yunzaixi-dev/tjuclaw') throw new Error('Unexpected source repository');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Invalid source commit');
  const ref = validateMirrorRef(env.GITHUB_REF);
  if (!env.GITLAB_SYNC_TOKEN) throw new Error('Missing project mirror credential');
  const options = { encoding: 'utf8', timeout: 120_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } };
  if (execute('git', ['rev-parse', 'HEAD'], options).trim() !== env.GITHUB_SHA) throw new Error('Checkout does not match source commit');
  const object = execute('git', ['rev-parse', '--verify', ref], options).trim();
  if (!/^[a-f0-9]{40}$/.test(object)) throw new Error('Invalid source ref object');
  const helper = fileURLToPath(new URL('./gitlab-credential.mjs', import.meta.url));
  // Git invokes this shell helper; single quotes prevent expansion in paths.
  const quotedHelper = `'${helper.replaceAll("'", "'\\''")}'`;
  execute('git', ['-c', 'credential.helper=', '-c', `credential.helper=!node ${quotedHelper}`,
    '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false',
    'push', '--atomic', '--porcelain', mirrorUrl, `${object}:${ref}`], options);
  return { source: env.GITHUB_SHA, ref };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(syncSource()));
  } catch {
    // Git errors can contain credential helper diagnostics: never echo raw stderr.
    console.error('GitLab source synchronization failed; check ref divergence and project credential permissions.');
    process.exitCode = 1;
  }
}
