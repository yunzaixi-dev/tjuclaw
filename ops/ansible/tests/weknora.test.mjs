import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function runPlaybook(variables) {
  return spawnSync('uv', [
    'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
    'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/deploy-weknora.yml',
    '-c', 'local',
    '-e', JSON.stringify(variables),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' },
  });
}

test('weknora_stack role preflight, rendering, and secret preservation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'weknora-stack-test-'));
  const baseDir = join(directory, 'opt');
  const baseVars = {
    weknora_base_dir: baseDir,
    weknora_app_listen_addr: '127.0.0.1:18181',
    weknora_ui_listen_addr: '127.0.0.1:18180',
    weknora_simulate: true,
    weknora_become: false,
  };

  try {
    const firstRun = runPlaybook(baseVars);
    assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);

    const envDbPath = join(baseDir, '.env.db');
    const envAppPath = join(baseDir, '.env.app');
    const composePath = join(baseDir, 'compose.yaml');
    assert.ok(existsSync(envDbPath));
    assert.ok(existsSync(envAppPath));
    assert.ok(existsSync(composePath));

    const envDb = readFileSync(envDbPath, 'utf8');
    const envApp = readFileSync(envAppPath, 'utf8');
    const compose = readFileSync(composePath, 'utf8');

    const dbPass = envDb.match(/^POSTGRES_PASSWORD=(.+)$/m)[1].trim();
    const aes = envApp.match(/^SYSTEM_AES_KEY=(.+)$/m)[1].trim();
    assert.ok(dbPass.length >= 32);
    assert.equal(aes.length, 32);
    assert.ok(envApp.includes(`DB_PASSWORD=${dbPass}`));
    assert.match(envApp, /^DISABLE_REGISTRATION=true$/m);
    assert.match(envApp, /^WEKNORA_SANDBOX_DOCKER_ENABLED=false$/m);
    assert.doesNotMatch(envApp, /^LLM_BASE_URL=/m);

    assert.match(compose, /memory: 384m/);
    assert.match(compose, /memory: 512m/);
    assert.match(compose, /internal: true/);
    assert.match(compose, /127\.0\.0\.1:18181:8080/);
    assert.match(compose, /wechatopenai\/weknora-app:v0\.8\.0/);
    assert.doesNotMatch(compose, /docker\.sock/);

    const secondRun = runPlaybook(baseVars);
    assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);
    assert.equal(readFileSync(envDbPath, 'utf8').match(/^POSTGRES_PASSWORD=(.+)$/m)[1].trim(), dbPass);
    assert.equal(readFileSync(envAppPath, 'utf8').match(/^SYSTEM_AES_KEY=(.+)$/m)[1].trim(), aes);

    const publicListen = runPlaybook({ ...baseVars, weknora_app_listen_addr: '0.0.0.0:18181' });
    assert.notEqual(publicListen.status, 0);
    assert.match(publicListen.stdout + publicListen.stderr, /bind strictly to loopback/);

    const publicUi = runPlaybook({ ...baseVars, weknora_ui_listen_addr: '0.0.0.0:18180' });
    assert.notEqual(publicUi.status, 0);
    assert.match(publicUi.stdout + publicUi.stderr, /bind strictly to loopback/);

    const oldVersion = runPlaybook({ ...baseVars, weknora_version: 'v0.6.0' });
    assert.notEqual(oldVersion.status, 0);
    assert.match(oldVersion.stdout + oldVersion.stderr, /v0\.8\.0 or newer/);

    const latest = runPlaybook({ ...baseVars, weknora_version: 'latest' });
    assert.notEqual(latest.status, 0);

    const sandbox = runPlaybook({ ...baseVars, weknora_sandbox_docker_enabled: true });
    assert.notEqual(sandbox.status, 0);
    assert.match(sandbox.stdout + sandbox.stderr, /docker\.sock/);

    const partialLlm = runPlaybook({ ...baseVars, weknora_llm_base_url: 'http://host.docker.internal:3000/v1' });
    assert.notEqual(partialLlm.status, 0);
    assert.match(partialLlm.stdout + partialLlm.stderr, /Incomplete LLM configuration/);

    const fullLlm = runPlaybook({
      ...baseVars,
      weknora_llm_base_url: 'http://host.docker.internal:3000/v1',
      weknora_llm_api_key: 'sk-test',
      weknora_llm_model_name: 'tju-llm',
    });
    assert.equal(fullLlm.status, 0, fullLlm.stdout + fullLlm.stderr);
    const envLlm = readFileSync(envAppPath, 'utf8');
    assert.match(envLlm, /^LLM_BASE_URL=http:\/\/host\.docker\.internal:3000\/v1$/m);
    assert.match(envLlm, /^LLM_API_KEY=sk-test$/m);
    assert.match(envLlm, /^LLM_MODEL_NAME=tju-llm$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
