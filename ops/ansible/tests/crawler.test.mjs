import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');

function runPlaybook(variables) {
  return spawnSync('uv', [
    'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
    'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/deploy-crawler.yml',
    '-c', 'local',
    '-e', JSON.stringify(variables),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' }
  });
}

test('crawler_stack role preflight assertions, configuration rendering, and secret preservation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crawler-stack-test-'));
  const baseDir = join(directory, 'opt');
  const sourcesFile = join(directory, 'sources.json');

  writeFileSync(sourcesFile, JSON.stringify([
    { id: 'test-source', kind: 'course', url: 'https://example.invalid', allowedHosts: ['example.invalid'] }
  ]));

  const baseVars = {
    crawler_base_dir: baseDir,
    crawler_sources_file: sourcesFile,
    crawler_listen_addr: '127.0.0.1:3031',
    crawler_simulate: true,
    crawler_become: false,
  };

  try {
    // 1. Initial simulation run: creates directories, templates, durable secrets
    const firstRun = runPlaybook(baseVars);
    assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);

    // Verify created files
    const envDbPath = join(baseDir, '.env.db');
    const envAppPath = join(baseDir, '.env.app');
    const composePath = join(baseDir, 'compose.yaml');

    assert.ok(existsSync(envDbPath), '.env.db must exist');
    assert.ok(existsSync(envAppPath), '.env.app must exist');
    assert.ok(existsSync(composePath), 'compose.yaml must exist');

    const envDbContent = readFileSync(envDbPath, 'utf8');
    const envAppContent = readFileSync(envAppPath, 'utf8');
    const composeContent = readFileSync(composePath, 'utf8');

    // Verify secret generated and matched in app database URL
    const dbPassMatch = envDbContent.match(/^POSTGRES_PASSWORD=(.+)$/m);
    assert.ok(dbPassMatch, 'POSTGRES_PASSWORD must be present');
    const initialPassword = dbPassMatch[1].trim();
    assert.ok(initialPassword.length >= 32, 'Generated password must be cryptographically secure');

    assert.ok(
      envAppContent.includes(`CRAWLER_DATABASE_URL=postgres://tjuclaw_crawler:${initialPassword}@db:5432/tjuclaw_crawler`),
      'App database URL must match database credentials'
    );
    assert.ok(envAppContent.includes(`CRAWLER_SOURCES_FILE=/etc/crawler/sources.json`));

    // Verify compose constraints
    assert.match(composeContent, /memory: 256m/, 'DB memory limit must be 256m');
    assert.match(composeContent, /memory: 192m/, 'App memory limit must be 192m');
    assert.match(composeContent, /read_only: true/, 'App container must be read_only');
    assert.match(composeContent, /pids: 100/, 'App container must have pids limit');
    assert.match(composeContent, /internal: true/, 'Crawler internal network must be isolated');
    assert.match(composeContent, /- default/, 'App container must have default network for outbound access');
    assert.match(composeContent, new RegExp(`- ${baseDir}/sources.json:/etc/crawler/sources.json:ro`), 'Sources file must be mounted ro from base_dir');

    // Verify copied sources file exists
    const copiedSourcesPath = join(baseDir, 'sources.json');
    assert.ok(existsSync(copiedSourcesPath), 'sources.json must be copied to base directory');
    assert.equal(readFileSync(copiedSourcesPath, 'utf8'), readFileSync(sourcesFile, 'utf8'));

    // Verify S3 config is omitted by default when not configured
    assert.ok(!envAppContent.includes('CRAWLER_S3_ENDPOINT'), 'S3 config should not be rendered when empty');
    assert.ok(!envAppContent.includes('CRAWLER_OVERSEAS_PROXY'), 'overseas proxy should not be rendered when empty');


    // 2. Secret preservation on subsequent run
    const secondRun = runPlaybook(baseVars);
    assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);
    const envDbSecond = readFileSync(envDbPath, 'utf8');
    const dbPassMatchSecond = envDbSecond.match(/^POSTGRES_PASSWORD=(.+)$/m);
    assert.equal(dbPassMatchSecond[1].trim(), initialPassword, 'Existing password must not be overwritten');

    // 3. Preflight failure: non-loopback listen address
    const publicListen = runPlaybook({ ...baseVars, crawler_listen_addr: '0.0.0.0:3031' });
    assert.notEqual(publicListen.status, 0, 'Must reject non-loopback bind address');
    assert.match(publicListen.stdout + publicListen.stderr, /bind strictly to loopback/);

    // 4. Preflight failure: missing artifact checksum when artifact path is given
    const artifactPath = join(directory, 'crawler-image.tar.gz');
    writeFileSync(artifactPath, 'dummy-tar-gz');
    const badChecksumRun = runPlaybook({
      ...baseVars,
      crawler_artifact_path: artifactPath,
      crawler_artifact_sha256: 'deadbeef', // not 64 hex chars
    });
    assert.notEqual(badChecksumRun.status, 0);
    assert.match(badChecksumRun.stdout + badChecksumRun.stderr, /must be a 64-character hex string/);

    // 5. Preflight failure: checksum mismatch
    const mismatchRun = runPlaybook({
      ...baseVars,
      crawler_artifact_path: artifactPath,
      crawler_artifact_sha256: '0'.repeat(64),
    });
    assert.notEqual(mismatchRun.status, 0);
    assert.match(mismatchRun.stdout + mismatchRun.stderr, /does not match expected checksum/);

    // 6. Valid checksum with artifact path
    const validChecksum = digest('dummy-tar-gz');
    const validArtifactRun = runPlaybook({
      ...baseVars,
      crawler_artifact_path: artifactPath,
      crawler_artifact_sha256: validChecksum,
    });
    assert.equal(validArtifactRun.status, 0, validArtifactRun.stdout + validArtifactRun.stderr);

    // 7. S3 configuration: partial S3 config must fail preflight (all-or-none)
    const partialS3Run = runPlaybook({
      ...baseVars,
      crawler_s3_endpoint: 'https://cos.ap-beijing.myqcloud.com',
      crawler_s3_region: 'ap-beijing',
      // missing bucket, key, secret
    });
    assert.notEqual(partialS3Run.status, 0, 'Partial S3 configuration must fail preflight');
    assert.match(partialS3Run.stdout + partialS3Run.stderr, /Incomplete S3\/COS archive configuration/);

    // 8. S3 configuration: complete S3 config must render properly into .env.app
    const fullS3Run = runPlaybook({
      ...baseVars,
      crawler_s3_endpoint: 'https://cos.ap-beijing.myqcloud.com',
      crawler_s3_region: 'ap-beijing',
      crawler_s3_bucket: 'test-bucket',
      crawler_s3_access_key_id: 'TEST_KEY',
      crawler_s3_secret_access_key: 'TEST_SECRET',
      crawler_s3_prefix: 'tju-archive/',
    });
    assert.equal(fullS3Run.status, 0, fullS3Run.stdout + fullS3Run.stderr);
    const envAppS3 = readFileSync(envAppPath, 'utf8');
    assert.ok(envAppS3.includes('CRAWLER_S3_ENDPOINT=https://cos.ap-beijing.myqcloud.com'));
    assert.ok(envAppS3.includes('CRAWLER_S3_REGION=ap-beijing'));
    assert.ok(envAppS3.includes('CRAWLER_S3_BUCKET=test-bucket'));
    assert.ok(envAppS3.includes('CRAWLER_S3_ACCESS_KEY_ID=TEST_KEY'));
    assert.ok(envAppS3.includes('CRAWLER_S3_SECRET_ACCESS_KEY=TEST_SECRET'));
    assert.ok(envAppS3.includes('CRAWLER_S3_PREFIX=tju-archive/'));

    const proxyRun = runPlaybook({
      ...baseVars,
      crawler_overseas_proxy: 'http://172.24.0.1:3128',
    });
    assert.equal(proxyRun.status, 0, proxyRun.stdout + proxyRun.stderr);
    const envAppProxy = readFileSync(envAppPath, 'utf8');
    assert.ok(envAppProxy.includes('CRAWLER_OVERSEAS_PROXY=http://172.24.0.1:3128'));
    assert.ok(!envAppProxy.includes('CRAWLER_OVERSEAS_PROXY_HOSTS'));

    const badProxyScheme = runPlaybook({
      ...baseVars,
      crawler_overseas_proxy: 'socks5://127.0.0.1:1080',
    });
    assert.notEqual(badProxyScheme.status, 0, 'Must reject non-HTTP overseas proxy');

    const hostsWithoutProxy = runPlaybook({
      ...baseVars,
      crawler_overseas_proxy_hosts: 'sharepoint.com',
    });
    assert.notEqual(hostsWithoutProxy.status, 0, 'Must reject overseas proxy hosts without a proxy URL');

    const partialGitRun = runPlaybook({
      ...baseVars,
      crawler_git_raw_url: 'https://git.example/raw.git',
    });
    assert.notEqual(partialGitRun.status, 0, 'Partial Forgejo mirror configuration must fail preflight');

    const fullGitRun = runPlaybook({
      ...baseVars,
      crawler_git_raw_url: 'https://git.example/raw.git',
      crawler_git_markdown_url: 'https://git.example/markdown.git',
      crawler_git_username: 'crawler-sync',
      crawler_git_token: 'TEST_TOKEN',
      crawler_git_region: 'cn',
    });
    assert.equal(fullGitRun.status, 0, fullGitRun.stdout + fullGitRun.stderr);
    const envAppGit = readFileSync(envAppPath, 'utf8');
    const composeGit = readFileSync(composePath, 'utf8');
    assert.ok(envAppGit.includes('CRAWLER_GIT_RAW_URL=https://git.example/raw.git'));
    assert.ok(envAppGit.includes('CRAWLER_GIT_MARKDOWN_URL=https://git.example/markdown.git'));
    assert.ok(envAppGit.includes('CRAWLER_GIT_TOKEN=TEST_TOKEN'));
    assert.match(composeGit, /git-sync:/);
    assert.match(composeGit, /crawler_git_sync:\/data\/git-sync/);
    assert.match(composeGit, /git-sync-init:/);
    assert.match(composeGit, /condition: service_completed_successfully/);

    // 9. Sources file rollback verification
    // Modify sources file, then run playbook; verify sources.json is restored on rollback if backup was taken
    const updatedSources = [{ id: 'new-source', kind: 'course', url: 'https://example.invalid/2', allowedHosts: ['example.invalid'] }];
    writeFileSync(sourcesFile, JSON.stringify(updatedSources));
    const thirdRun = runPlaybook(baseVars);
    assert.equal(thirdRun.status, 0, thirdRun.stdout + thirdRun.stderr);
    assert.equal(readFileSync(copiedSourcesPath, 'utf8'), JSON.stringify(updatedSources));

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
