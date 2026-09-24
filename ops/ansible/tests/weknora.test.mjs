import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function runPlaybook(variables, inventory = 'localhost,') {
  return spawnSync('uv', [
    'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
    'ansible-playbook', '-i', inventory, 'ops/ansible/playbooks/deploy-weknora.yml',
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
  const inventoryPath = join(directory, 'inventory.yml');
  writeFileSync(inventoryPath, 'all:\n  children:\n    weknora_nodes:\n      hosts:\n        localhost:\n          ansible_connection: local\n');
  const run = (variables) => runPlaybook(variables, inventoryPath);
  const baseVars = {
    weknora_base_dir: baseDir,
    weknora_app_listen_addr: '127.0.0.1:18181',
    weknora_ui_listen_addr: '127.0.0.1:18180',
    weknora_simulate: true,
    weknora_become: false,
  };

  try {
    const firstRun = run(baseVars);
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
    assert.doesNotMatch(compose, /cloudflared/);

    const secondRun = run(baseVars);
    assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);
    assert.equal(readFileSync(envDbPath, 'utf8').match(/^POSTGRES_PASSWORD=(.+)$/m)[1].trim(), dbPass);
    assert.equal(readFileSync(envAppPath, 'utf8').match(/^SYSTEM_AES_KEY=(.+)$/m)[1].trim(), aes);

    const publicListen = run({ ...baseVars, weknora_app_listen_addr: '0.0.0.0:18181' });
    assert.notEqual(publicListen.status, 0);
    assert.match(publicListen.stdout + publicListen.stderr, /bind strictly to loopback/);

    const publicUi = run({ ...baseVars, weknora_ui_listen_addr: '0.0.0.0:18180' });
    assert.notEqual(publicUi.status, 0);
    assert.match(publicUi.stdout + publicUi.stderr, /bind strictly to loopback/);

    const oldVersion = run({ ...baseVars, weknora_version: 'v0.6.0' });
    assert.notEqual(oldVersion.status, 0);
    assert.match(oldVersion.stdout + oldVersion.stderr, /v0\.8\.0 or newer/);

    const latest = run({ ...baseVars, weknora_version: 'latest' });
    assert.notEqual(latest.status, 0);

    const sandbox = run({ ...baseVars, weknora_sandbox_docker_enabled: true });
    assert.notEqual(sandbox.status, 0);
    assert.match(sandbox.stdout + sandbox.stderr, /docker\.sock/);

    const partialLlm = run({ ...baseVars, weknora_llm_base_url: 'http://host.docker.internal:3000/v1' });
    assert.notEqual(partialLlm.status, 0);
    assert.match(partialLlm.stdout + partialLlm.stderr, /Chat configuration must use exactly one complete namespace/);

    const fullLlm = run({
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

    const splitRoles = run({
      ...baseVars,
      weknora_chat_base_url: 'http://chat.invalid/v1',
      weknora_chat_api_key: 'chat-test-key',
      weknora_chat_model_name: 'chat-model',
      weknora_embedding_base_url: 'http://embedding.invalid/v1',
      weknora_embedding_api_key: 'embedding-test-key',
      weknora_embedding_model_name: 'embedding-model',
      weknora_embedding_dimension: 1024,
      weknora_rerank_base_url: 'http://rerank.invalid/v1',
      weknora_rerank_api_key: 'rerank-test-key',
      weknora_rerank_model_name: 'rerank-model',
    });
    assert.equal(splitRoles.status, 0, splitRoles.stdout + splitRoles.stderr);
    const splitEnv = readFileSync(envAppPath, 'utf8');
    assert.match(splitEnv, /^LLM_BASE_URL=http:\/\/chat\.invalid\/v1$/m);
    assert.match(splitEnv, /^LLM_API_KEY=chat-test-key$/m);
    assert.match(splitEnv, /^LLM_MODEL_NAME=chat-model$/m);
    assert.match(splitEnv, /^EMBEDDING_BASE_URL=http:\/\/embedding\.invalid\/v1$/m);
    assert.match(splitEnv, /^EMBEDDING_API_KEY=embedding-test-key$/m);
    assert.match(splitEnv, /^EMBEDDING_MODEL_NAME=embedding-model$/m);
    assert.match(splitEnv, /^EMBEDDING_DIMENSION=1024$/m);
    assert.match(splitEnv, /^RERANK_BASE_URL=http:\/\/rerank\.invalid\/v1$/m);
    assert.match(splitEnv, /^RERANK_API_KEY=rerank-test-key$/m);
    assert.match(splitEnv, /^RERANK_MODEL_NAME=rerank-model$/m);

    for (const [name, value] of [
      ['weknora_chat_api_key', 'chat-test-key'],
      ['weknora_embedding_model_name', 'embedding-model'],
      ['weknora_rerank_base_url', 'http://rerank.invalid/v1'],
    ]) {
      const partialRole = run({ ...baseVars, [name]: value });
      assert.notEqual(partialRole.status, 0);
      assert.match(partialRole.stdout + partialRole.stderr, /Chat configuration must use exactly one complete namespace|Incomplete (embedding|rerank) configuration/);
    }

    const legacyChat = {
      weknora_llm_base_url: 'http://legacy.invalid/v1',
      weknora_llm_api_key: 'legacy-key',
      weknora_llm_model_name: 'legacy-model',
    };
    const partialSplitWithLegacy = run({
      ...baseVars,
      ...legacyChat,
      weknora_chat_base_url: 'http://chat.invalid/v1',
    });
    assert.notEqual(partialSplitWithLegacy.status, 0);
    assert.match(partialSplitWithLegacy.stdout + partialSplitWithLegacy.stderr, /Chat configuration must use exactly one complete namespace/);

    const completeNamespaces = run({
      ...baseVars,
      ...legacyChat,
      weknora_chat_base_url: 'http://chat.invalid/v1',
      weknora_chat_api_key: 'chat-test-key',
      weknora_chat_model_name: 'chat-model',
    });
    assert.notEqual(completeNamespaces.status, 0);
    assert.match(completeNamespaces.stdout + completeNamespaces.stderr, /Chat configuration must use exactly one complete namespace/);

    const invalidDimension = run({
      ...baseVars,
      weknora_embedding_base_url: 'http://embedding.invalid/v1',
      weknora_embedding_api_key: 'embedding-test-key',
      weknora_embedding_model_name: 'embedding-model',
      weknora_embedding_dimension: 0,
    });
    assert.notEqual(invalidDimension.status, 0);
    assert.match(invalidDimension.stdout + invalidDimension.stderr, /embedding dimension must be positive/);

    const emptyRoles = run({ ...baseVars, weknora_chat_base_url: '', weknora_embedding_dimension: '' });
    assert.equal(emptyRoles.status, 0, emptyRoles.stdout + emptyRoles.stderr);
    const emptyEnv = readFileSync(envAppPath, 'utf8');
    assert.doesNotMatch(emptyEnv, /^EMBEDDING_/m);
    assert.doesNotMatch(emptyEnv, /^RERANK_/m);

    const tunnelToken = 'tunnel-token-for-test-' + 'x'.repeat(32);
    const tunnel = run({
      ...baseVars,
      weknora_tunnel_enabled: true,
      weknora_tunnel_token: tunnelToken,
    });
    assert.equal(tunnel.status, 0, tunnel.stdout + tunnel.stderr);
    const tunnelCompose = readFileSync(composePath, 'utf8');
    assert.match(tunnelCompose, /cloudflare\/cloudflared:/);
    assert.match(tunnelCompose, /--token-file/);
    assert.match(tunnelCompose, /file: \.tunnel-token/);
    assert.equal(readFileSync(join(baseDir, '.tunnel-token'), 'utf8').trim(), tunnelToken);

    const missingTunnelToken = run({ ...baseVars, weknora_tunnel_enabled: true });
    assert.notEqual(missingTunnelToken.status, 0);
    assert.match(missingTunnelToken.stdout + missingTunnelToken.stderr, /requires the approved token/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('weknora deployment requires a non-empty dedicated host group', () => {
  const missingGroup = runPlaybook({
    weknora_base_dir: join(tmpdir(), 'weknora-missing-group'),
    weknora_app_listen_addr: '127.0.0.1:18181',
    weknora_ui_listen_addr: '127.0.0.1:18180',
    weknora_simulate: true,
    weknora_become: false,
  });
  assert.notEqual(missingGroup.status, 0);
  assert.match(missingGroup.stdout + missingGroup.stderr, /weknora_nodes/);
});

test('conditional retrieval gateway tunnel example is fail-closed', () => {
  const config = readFileSync(join(root, 'ops/tunnel/config.example.yml'), 'utf8');
  const readme = readFileSync(join(root, 'ops/tunnel/README.md'), 'utf8');
  const ingress = config.split('ingress:\n')[1].trim().split('\n');
  assert.match(config, /tunnel: REPLACE_WITH_APPROVED_TUNNEL_ID/);
  assert.match(config, /hostname: retrieval-gateway\.example\.invalid/);
  assert.match(config, /service: http:\/\/127\.0\.0\.1:18443/);
  assert.match(config, /service: http_status:404/);
  assert.equal(ingress.at(-1), '  - service: http_status:404');
  assert.doesNotMatch(config, /weknora|18180|18181|docker\.sock|token:|api_key:/i);
  assert.match(readme, /approved retrieval gateway/i);
  assert.match(readme, /account ownership/i);
  assert.match(readme, /zone ownership/i);
  assert.match(readme, /hostname[\s]+ownership/i);
  assert.match(readme, /catch-all.*404/i);
  assert.match(readme, /not.*UI|not.*app/i);
});
