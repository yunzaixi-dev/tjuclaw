import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function runPlaybook(variables) {
  return spawnSync('uv', [
    'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
    'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/deploy-zitadel.yml',
    '-c', 'local',
    '-e', JSON.stringify(variables),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' }
  });
}

test('zitadel role preflight assertions, compose rendering, credential decoding, and secret preservation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zitadel-role-test-'));
  const baseDir = join(directory, 'opt');
  const smtpEnvFile = join(directory, 'tjuclaw-identity-smtp.env');

  // Username and password with @ : $ percent-encoded
  // user@example.com -> user%40example.com
  // p:a$s:w@o$r:d -> p%3Aa%24s%3Aw%40o%24r%3Ad
  const rawUser = 'mailer@service.internal';
  const rawPass = 'auth:key$secret:token@val$123';
  const encodedUser = encodeURIComponent(rawUser);
  const encodedPass = encodeURIComponent(rawPass);
  const fromAddr = 'notify@app.tjuclaw.cloud';

  writeFileSync(
    smtpEnvFile,
    `COURIER_SMTP_CONNECTION_URI=smtps://${encodedUser}:${encodedPass}@smtp.tjuclaw.cloud:465\nCOURIER_SMTP_FROM_ADDRESS=${fromAddr}\n`,
    { mode: 0o600 }
  );

  const baseVars = {
    zitadel_base_dir: baseDir,
    zitadel_smtp_env_file: smtpEnvFile,
    zitadel_listen_addr: '127.0.0.1:8085',
    zitadel_simulate: true,
    zitadel_become: false,
  };

  try {
    // 1. Initial simulation run: renders configs and creates secrets
    const firstRun = runPlaybook(baseVars);
    assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);

    const envDbPath = join(baseDir, '.env.db');
    const envZitadelPath = join(baseDir, '.env.zitadel');
    const composePath = join(baseDir, 'compose.yaml');

    assert.ok(existsSync(envDbPath), '.env.db must exist');
    assert.ok(existsSync(envZitadelPath), '.env.zitadel must exist');
    assert.ok(existsSync(composePath), 'compose.yaml must exist');

    assert.equal(statSync(envDbPath).mode & 0o777, 0o600);
    assert.equal(statSync(envZitadelPath).mode & 0o777, 0o600);

    const envDbContent = readFileSync(envDbPath, 'utf8');
    const envZitadelContent = readFileSync(envZitadelPath, 'utf8');
    const composeContent = readFileSync(composePath, 'utf8');

    // Verify secrets generated
    const dbPassMatch = envDbContent.match(/^POSTGRES_PASSWORD=(.+)$/m);
    assert.ok(dbPassMatch, 'POSTGRES_PASSWORD must be present');
    const initialDbPass = dbPassMatch[1].trim();
    assert.ok(initialDbPass.length >= 32, 'POSTGRES_PASSWORD must be >= 32 chars');

    const masterkeyMatch = envZitadelContent.match(/^ZITADEL_MASTERKEY=(.+)$/m);
    assert.ok(masterkeyMatch, 'ZITADEL_MASTERKEY must be present');
    const initialMasterkey = masterkeyMatch[1].trim();
    assert.equal(initialMasterkey.length, 32, 'ZITADEL_MASTERKEY must be exactly 32 chars');

    // Verify percent-encoded SMTP credentials decoded correctly including @ : $
    assert.ok(
      envZitadelContent.includes(`ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_USER=${rawUser}`),
      'SMTP user must be decoded with @ preserved'
    );
    assert.ok(
      envZitadelContent.includes(`ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_PASSWORD=${rawPass}`),
      'SMTP password must be decoded with : and $ preserved'
    );
    assert.ok(
      envZitadelContent.includes('ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_HOST=smtp.tjuclaw.cloud:465')
    );

    // Verify compose constraints: pinned images, commands, raw env_file format, no wget healthcheck
    assert.match(composeContent, /image: "postgres:16\.14-alpine"/);
    assert.match(composeContent, /image: "ghcr\.io\/zitadel\/zitadel:v4\.17\.3"/);
    assert.match(composeContent, /format: raw/, 'env_file must use raw format');
    assert.match(composeContent, /command: init\b/, 'zitadel-init must run init');
    assert.match(composeContent, /command: setup --masterkeyFromEnv\b/, 'zitadel-setup must run setup --masterkeyFromEnv');
    assert.match(composeContent, /command: start --masterkeyFromEnv --tlsMode external\b/, 'zitadel must run start');
    assert.ok(!composeContent.includes('wget --spider') && !composeContent.includes('wget -q') && !composeContent.includes('test: ["CMD", "wget"'), 'Distroless ZITADEL compose must not contain wget healthcheck');

    // Verify compose validity via docker compose config
    const parsed = spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, 'Rendered Compose must be accepted by Docker Compose');
    const services = JSON.parse(parsed.stdout).services;
    assert.equal(services.zitadel.ports[0].host_ip, '127.0.0.1');
    assert.equal(services.zitadel.ports[0].target, 8080);
    assert.equal(services.db.ports, undefined, 'Database port must not be published');
    assert.equal(services.zitadel.healthcheck, undefined, 'ZITADEL readiness is checked over HTTP by Ansible');
    // `compose config` escapes literal dollars so its output can be reused as input.
    assert.equal(services.zitadel.environment.ZITADEL_DEFAULTINSTANCE_SMTPCONFIGURATION_SMTP_PASSWORD.replaceAll('$$', '$'), rawPass, 'Rendered Compose preserves literal $ in SMTP credentials');
    assert.equal(statSync(join(baseDir, 'bootstrap')).mode & 0o777, 0o700);
    assert.match(envZitadelContent, /ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=zitadel-owner/);
    assert.match(envZitadelContent, /ZITADEL_FIRSTINSTANCE_ORG_LOGINCLIENT_MACHINE_USERNAME=login-client/);

    // 2. Secret preservation on rerun
    const secondRun = runPlaybook(baseVars);
    assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);

    const envDbSecond = readFileSync(envDbPath, 'utf8');
    const envZitadelSecond = readFileSync(envZitadelPath, 'utf8');
    assert.equal(
      envDbSecond.match(/^POSTGRES_PASSWORD=(.+)$/m)[1].trim(),
      initialDbPass,
      'POSTGRES_PASSWORD must be preserved across runs'
    );
    assert.equal(
      envZitadelSecond.match(/^ZITADEL_MASTERKEY=(.+)$/m)[1].trim(),
      initialMasterkey,
      'ZITADEL_MASTERKEY must be preserved across runs'
    );

    // 3. Reject unsupported SMTP TLS overrides
    const badTlsEnvFile = join(directory, 'bad-tls.env');
    writeFileSync(
      badTlsEnvFile,
      `COURIER_SMTP_CONNECTION_URI=smtps://${encodedUser}:${encodedPass}@smtp.tjuclaw.cloud:465?skip_ssl_verify=true\nCOURIER_SMTP_FROM_ADDRESS=${fromAddr}\n`,
      { mode: 0o600 }
    );
    const rejectTlsRun = runPlaybook({ ...baseVars, zitadel_smtp_env_file: badTlsEnvFile });
    assert.notEqual(rejectTlsRun.status, 0, 'Must reject skip_ssl_verify=true');

    // 4. Reject insecure plain smtp on port 587
    const insecureSmtpEnvFile = join(directory, 'insecure-smtp.env');
    writeFileSync(
      insecureSmtpEnvFile,
      `COURIER_SMTP_CONNECTION_URI=smtp://${encodedUser}:${encodedPass}@smtp.tjuclaw.cloud:587\nCOURIER_SMTP_FROM_ADDRESS=${fromAddr}\n`,
      { mode: 0o600 }
    );
    const rejectInsecureRun = runPlaybook({ ...baseVars, zitadel_smtp_env_file: insecureSmtpEnvFile });
    assert.notEqual(rejectInsecureRun.status, 0, 'Must reject non-smtps 465 SMTP URI');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
