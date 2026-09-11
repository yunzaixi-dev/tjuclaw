import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_SIZE_BYTES, VALID_FILENAME_REGEX, validateSha, validateSha256 } from './gitlab-release.mjs';

const gitlab = 'https://gitlab.tju.edu.cn/api/v4/projects/145';
const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

export function validateBuildManifest(manifest, expectedSha) {
  if (manifest?.source_sha !== expectedSha) throw new Error('Package source does not match pinned client');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? '')) throw new Error('Invalid client version');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error('Expected three native packages');
  const extensions = new Set();
  for (const file of manifest.files) {
    if (!VALID_FILENAME_REGEX.test(file.name) || !/\.(deb|apk|exe)$/.test(file.name)) throw new Error('Invalid native package filename');
    const extension = file.name.split('.').at(-1);
    if (extensions.has(extension)) throw new Error('Duplicate native platform');
    extensions.add(extension);
    validateSha256(file.sha256);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_SIZE_BYTES) throw new Error('Invalid package size');
  }
  return manifest;
}

async function request(url, token, kind = 'PRIVATE-TOKEN') {
  const response = await fetch(url, { headers: { [kind]: kind === 'Authorization' ? `Bearer ${token}` : token },
    redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Release prerequisite HTTP ${response.status}`);
  return response;
}

async function boundedJson(response, limit = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('Release metadata too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function requirePassingIntegration(sha, token) {
  const url = `https://api.github.com/repos/yunzaixi-dev/tjuclaw/actions/runs?head_sha=${sha}&event=push&branch=release&per_page=30`;
  const data = await boundedJson(await request(url, token, 'Authorization'));
  const run = data.workflow_runs?.filter(item => item.name === 'CI' && item.head_sha === sha
    && item.head_repository?.full_name === 'yunzaixi-dev/tjuclaw')
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (run?.status !== 'completed' || run.conclusion !== 'success') throw new Error('Latest integration CI must pass before publication');
}

export async function prepareRelease(env = process.env) {
  if (env.GITHUB_REPOSITORY !== 'yunzaixi-dev/tjuclaw' || env.GITHUB_REF !== 'refs/heads/release') throw new Error('Publish from trusted integration release only');
  const ref = validateSha(env.GITHUB_SHA);
  if (git('rev-parse', 'HEAD') !== ref) throw new Error('Integration checkout mismatch');
  const version = env.RELEASE_VERSION;
  const metadata = JSON.parse(git('show', `${ref}:package.json`));
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')
    || (version !== metadata.version && !version.startsWith(`${metadata.version}-`))) throw new Error('Release version must match integration metadata (optional prerelease suffix)');
  if (!env.GITLAB_RELEASE_TOKEN || !env.GITHUB_TOKEN) throw new Error('Missing publication credentials');
  await requirePassingIntegration(ref, env.GITHUB_TOKEN);
  const components = {};
  for (const path of ['frontend', 'backend', 'cli', 'crawler']) {
    const entry = git('ls-tree', ref, path).split(/\s+/);
    if (entry[0] !== '160000') throw new Error('Missing component gitlink');
    const sha = validateSha(entry[2]);
    if (git('-C', path, 'rev-parse', 'HEAD') !== sha) throw new Error('Component checkout mismatch');
    components[path] = sha;
  }
  const clientSha = components.frontend;
  const packageBase = `${gitlab}/packages/generic/tjuclaw-client/${clientSha}`;
  const build = validateBuildManifest(await boundedJson(await request(`${packageBase}/manifest.json`, env.GITLAB_RELEASE_TOKEN), 65536), clientSha);
  const clientMetadata = JSON.parse(git('-C', 'frontend', 'show', `${clientSha}:package.json`));
  if (build.version !== clientMetadata.version) throw new Error('Staged client version does not match source metadata');
  const directory = await mkdtemp(join(tmpdir(), 'tjuclaw-release-'));
  const files = [];
  for (const file of build.files) {
    const response = await request(`${packageBase}/${encodeURIComponent(file.name)}`, env.GITLAB_RELEASE_TOKEN);
    const digest = createHash('sha256');
    let count = 0;
    async function* verifiedBytes() {
      for await (const chunk of response.body) {
        count += chunk.length;
        if (count > file.size) throw new Error('Downloaded package exceeds manifest size');
        digest.update(chunk);
        yield chunk;
      }
    }
    const path = join(directory, file.name);
    await writeFile(path, verifiedBytes(), { flag: 'wx', mode: 0o600 });
    if (count !== file.size || digest.digest('hex') !== file.sha256) throw new Error('Downloaded package checksum mismatch');
    files.push({ name: file.name, path, sha256: file.sha256 });
  }

  // Archive tracked commit trees only: never copy working directories or ignored state.
  const tree = join(directory, 'source');
  await mkdir(tree);
  const archive = join(directory, 'tree.tar');
  git('archive', '--format=tar', `--output=${archive}`, ref);
  execFileSync('tar', ['-xf', archive, '-C', tree]);
  await rm(join(tree, '.gitmodules'), { force: true });
  for (const [path, sha] of Object.entries(components)) {
    await mkdir(join(tree, path), { recursive: true });
    git('-C', path, 'archive', '--format=tar', `--output=${archive}`, sha);
    execFileSync('tar', ['-xf', archive, '-C', join(tree, path)]);
  }
  await writeFile(join(tree, 'SOURCE.json'), `${JSON.stringify({ version, github_repository: env.GITHUB_REPOSITORY, integration_sha: ref, components }, null, 2)}\n`);
  const sourceName = `TJUClaw-source-${version}.tar.gz`;
  const sourcePath = join(directory, sourceName);
  const timestamp = git('show', '-s', '--format=%ct', ref);
  execFileSync('tar', ['--sort=name', `--mtime=@${timestamp}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', sourcePath, '-C', tree, '.']);
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  files.push({ name: sourceName, path: sourcePath, sha256: sourceHash });
  const sums = `${files.map(file => `${file.sha256}  ${file.name}`).join('\n')}\n`;
  const sumsPath = join(directory, 'SHA256SUMS.txt');
  await writeFile(sumsPath, sums);
  files.push({ name: 'SHA256SUMS.txt', path: sumsPath, sha256: createHash('sha256').update(sums).digest('hex') });
  const manifestPath = join(directory, 'release-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ version, tag: `v${version}`, ref, client_sha: clientSha, files,
    description: `开发验证版 ${version}。Windows 安装程序未签名，Android 为 arm64 调试包；尚未验收真机安装及登录。\n\nGitHub 集成提交：${ref}\n客户端提交：${clientSha}\n\n源码快照包含客户端、服务端、CLI/Skill、RSS 采集服务与集成材料，无需访问私有 GitHub 子仓库。请核对 SHA256SUMS.txt。\n\n文件实际存储于 GitLab；比赛下载计数的具体口径尚未核实。` }, null, 2));
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `manifest=${manifestPath}\n`);
  return manifestPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareRelease().then(path => console.log(`Prepared verified release manifest: ${path}`)).catch(() => {
    console.error('Release preparation failed. Check pinned CI, staged packages, checksums and credentials.');
    process.exitCode = 1;
  });
}
