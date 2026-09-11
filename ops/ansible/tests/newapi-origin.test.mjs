import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('newapi_origin role configuration template and preflight assertions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'newapi-origin-test-'));
  const certPath = join(directory, 'tls.pem');
  const configDir = join(directory, 'config');
  const configFile = join(configDir, 'haproxy.cfg');
  const unitFile = join(directory, 'tjuclaw-newapi-origin.service');

  try {
    // Generate self-signed valid TLS PEM bundle (cert + key)
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${directory}/key.pem" -out "${directory}/cert.pem" -days 1 -nodes -subj "/CN=newapi.tjuclaw.cloud" 2>/dev/null`);
    const certData = readFileSync(join(directory, 'cert.pem'), 'utf8');
    const keyData = readFileSync(join(directory, 'key.pem'), 'utf8');
    writeFileSync(certPath, certData + '\n' + keyData, { mode: 0o600 });

    const variables = {
      newapi_origin_hostname: 'newapi.tjuclaw.cloud',
      newapi_origin_port: 8443,
      newapi_origin_backend_address: '127.0.0.1',
      newapi_origin_backend_port: 3000,
      newapi_origin_tls_pem: certPath,
      newapi_origin_config_dir: configDir,
      newapi_origin_config_file: configFile,
      newapi_origin_unit_file: unitFile,
      newapi_origin_memory_limit: '96M',
      newapi_origin_simulate: true,
      newapi_origin_become: false,
    };

    const run = (values) => spawnSync('uv', [
      'run', '--no-project', '--with-requirements', 'ops/ansible/requirements.txt',
      'ansible-playbook', '-i', 'localhost,', 'ops/ansible/playbooks/deploy-newapi-origin.yml',
      '-c', 'local',
      '-e', JSON.stringify(values),
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ANSIBLE_CONFIG: join(root, 'ops/ansible/ansible.cfg'), ANSIBLE_NOCOLOR: '1' }
    });

    // 1. Success run with valid PEM
    const first = run(variables);
    assert.equal(first.status, 0, first.stdout + first.stderr);

    // Verify rendered haproxy configuration content
    const haproxyCfg = readFileSync(configFile, 'utf8');
    assert.match(haproxyCfg, /bind :8443 ssl crt/);
    assert.match(haproxyCfg, /timeout client 300s/);
    assert.match(haproxyCfg, /timeout server 300s/);
    assert.match(haproxyCfg, /timeout tunnel 1h/);
    assert.match(haproxyCfg, /acl valid_host hdr\(host\) -i newapi\.tjuclaw\.cloud newapi\.tjuclaw\.cloud:443 newapi\.tjuclaw\.cloud:8443/);
    assert.match(haproxyCfg, /http-request deny deny_status 404 unless valid_host/);
    assert.match(haproxyCfg, /http-request del-header X-Forwarded-For/);
    assert.match(haproxyCfg, /http-request set-header X-Forwarded-For %\[src\]/);
    assert.match(haproxyCfg, /http-request set-header X-Forwarded-Proto https/);
    assert.match(haproxyCfg, /http-request set-header X-Forwarded-Port 443/);
    assert.match(haproxyCfg, /server newapi_app 127\.0\.0\.1:3000 check/);

    // Verify rendered systemd service unit content
    const unitContent = readFileSync(unitFile, 'utf8');
    assert.match(unitContent, /ExecStart=\/usr\/sbin\/haproxy -Ws -f/);
    assert.match(unitContent, /ExecReload=\/bin\/kill -USR2 \$MAINPID/);
    assert.match(unitContent, /MemoryMax=96M/);
    assert.match(unitContent, /MemoryHigh=96M/);
    assert.match(unitContent, /ProtectSystem=strict/);

    // 2. Preflight failure: missing TLS file
    const missingRes = run({ ...variables, newapi_origin_tls_pem: join(directory, 'nonexistent.pem') });
    assert.notEqual(missingRes.status, 0);
    assert.match(missingRes.stdout + missingRes.stderr, /is missing, not a regular file, or empty/);

    // 3. Preflight failure: empty TLS file
    const emptyPem = join(directory, 'empty.pem');
    writeFileSync(emptyPem, '');
    const emptyRes = run({ ...variables, newapi_origin_tls_pem: emptyPem });
    assert.notEqual(emptyRes.status, 0);
    assert.match(emptyRes.stdout + emptyRes.stderr, /is missing, not a regular file, or empty/);

    // 4. Preflight failure: corrupt/invalid TLS file (not valid PEM)
    const corruptPem = join(directory, 'corrupt.pem');
    writeFileSync(corruptPem, 'not-a-valid-certificate-or-key');
    const corruptRes = run({ ...variables, newapi_origin_tls_pem: corruptPem });
    assert.notEqual(corruptRes.status, 0);

    // 5. Auth origin disabled by default; when enabled without auth SAN in cert, preflight fails closed
    const authFailRes = run({ ...variables, newapi_origin_auth_enabled: true });
    assert.notEqual(authFailRes.status, 0);
    assert.match(authFailRes.stdout + authFailRes.stderr, /does not match auth hostname/);

    // 6. When cert includes both newapi and auth SANs, auth origin enabled succeeds
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${directory}/multi-key.pem" -out "${directory}/multi-cert.pem" -days 1 -nodes -subj "/CN=newapi.tjuclaw.cloud" -addext "subjectAltName=DNS:newapi.tjuclaw.cloud,DNS:auth.tjuclaw.cloud" 2>/dev/null`);
    const multiCertData = readFileSync(join(directory, 'multi-cert.pem'), 'utf8');
    const multiKeyData = readFileSync(join(directory, 'multi-key.pem'), 'utf8');
    const multiCertPath = join(directory, 'multi-tls.pem');
    writeFileSync(multiCertPath, multiCertData + '\n' + multiKeyData, { mode: 0o600 });

    const authSuccessRes = run({
      ...variables,
      newapi_origin_tls_pem: multiCertPath,
      newapi_origin_auth_enabled: true,
      newapi_origin_auth_hostname: 'auth.tjuclaw.cloud',
      newapi_origin_auth_backend_address: '127.0.0.1',
      newapi_origin_auth_backend_port: 18080,
      newapi_origin_auth_redirect_target: 'https://app.tjuclaw.cloud/auth/login',
    });
    assert.equal(authSuccessRes.status, 0, authSuccessRes.stdout + authSuccessRes.stderr);

    const authHaproxyCfg = readFileSync(configFile, 'utf8');
    assert.match(authHaproxyCfg, /acl is_newapi_host hdr\(host\) -i newapi\.tjuclaw\.cloud/);
    assert.match(authHaproxyCfg, /acl is_auth_host hdr\(host\) -i auth\.tjuclaw\.cloud/);
    assert.match(authHaproxyCfg, /http-request set-log-level silent if is_auth_host/);
    assert.match(authHaproxyCfg, /http-request deny deny_status 404 unless is_newapi_host or is_auth_host/);
    assert.match(authHaproxyCfg, /http-request redirect location https:\/\/app\.tjuclaw\.cloud\/auth\/login code 302 if is_auth_host is_root/);
    assert.match(authHaproxyCfg, /acl is_api_exact path -m str \/api/);
    assert.match(authHaproxyCfg, /acl is_api_prefix path_beg \/api\//);
    assert.match(authHaproxyCfg, /http-request deny deny_status 404 if is_auth_host !is_api_exact !is_api_prefix/);
    assert.match(authHaproxyCfg, /http-request set-path %\[path,regsub\(\^\/api,\)\] if is_auth_host is_api_prefix/);
    assert.match(authHaproxyCfg, /http-request set-path \/ if is_auth_host is_api_exact/);
    assert.match(authHaproxyCfg, /use_backend auth_backend if is_auth_host/);
    assert.match(authHaproxyCfg, /backend auth_backend/);
    assert.match(authHaproxyCfg, /server auth_app 127\.0\.0\.1:18080 check/);

    // Verify ordering: silent log level MUST precede deny/redirect rules to prevent logging leaks on early-exit
    const silentIndex = authHaproxyCfg.indexOf('http-request set-log-level silent if is_auth_host');
    const denyIndex = authHaproxyCfg.indexOf('http-request deny deny_status 404 unless is_newapi_host or is_auth_host');
    const redirectIndex = authHaproxyCfg.indexOf('http-request redirect location');
    assert.ok(silentIndex !== -1, 'silent log level rule present');
    assert.ok(silentIndex < denyIndex, 'silent log level must be evaluated before host deny rule');
    assert.ok(silentIndex < redirectIndex, 'silent log level must be evaluated before redirect rule');

    // 7. Suffix attack resistance: cert with suffix attack domain fails checkhost preflight
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${directory}/evil-key.pem" -out "${directory}/evil-cert.pem" -days 1 -nodes -subj "/CN=newapi.tjuclaw.cloud" -addext "subjectAltName=DNS:newapi.tjuclaw.cloud,DNS:auth.tjuclaw.cloud.evil" 2>/dev/null`);
    const evilCertData = readFileSync(join(directory, 'evil-cert.pem'), 'utf8');
    const evilKeyData = readFileSync(join(directory, 'evil-key.pem'), 'utf8');
    const evilCertPath = join(directory, 'evil-tls.pem');
    writeFileSync(evilCertPath, evilCertData + '\n' + evilKeyData, { mode: 0o600 });

    const evilSuffixRes = run({
      ...variables,
      newapi_origin_tls_pem: evilCertPath,
      newapi_origin_auth_enabled: true,
      newapi_origin_auth_hostname: 'auth.tjuclaw.cloud',
    });
    assert.notEqual(evilSuffixRes.status, 0);
    assert.match(evilSuffixRes.stdout + evilSuffixRes.stderr, /does not match auth hostname auth\.tjuclaw\.cloud/);

    // Also test haproxy ACL host matching: hdr(host) -i does exact token matching and does not match suffix domain
    // Verify in HAProxy config: hdr(host) -i is used (exact match in haproxy), not hdr_end or regex
    assert.match(authHaproxyCfg, /acl is_auth_host hdr\(host\) -i auth\.tjuclaw\.cloud auth\.tjuclaw\.cloud:443 auth\.tjuclaw\.cloud:8443/);

  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
