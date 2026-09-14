import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseSimpleEnv,
  parseSmtpUri,
  resolveAuthDevMailConfig,
  validateEmailAddress,
} from './auth-mail-config.mjs';

test('parseSimpleEnv parses key-value pairs, trims, and ignores comments and blanks', () => {
  const envText = `
# Comment line
FOO=bar
${'  SPACED_KEY =  value with spaces  '}
QUOTED="quoted-val"
SINGLE='single-val'
EMPTY=
  `;
  const parsed = parseSimpleEnv(envText);
  assert.deepEqual(parsed, {
    FOO: 'bar',
    SPACED_KEY: 'value with spaces',
    QUOTED: 'quoted-val',
    SINGLE: 'single-val',
    EMPTY: '',
  });
});

test('parseSmtpUri parses valid smtps and smtp URLs with encoded credentials', () => {
  const uri1 = 'smtps://resend:re_123456@smtp.resend.com:465/';
  const res1 = parseSmtpUri(uri1);
  assert.deepEqual(res1, {
    host: 'smtp.resend.com:465',
    user: 'resend',
    password: 're_123456',
    tls: 'true',
  });

  const uri2 = 'smtps://user%40example.com:pass%23word@mail.example.com:465';
  const res2 = parseSmtpUri(uri2);
  assert.deepEqual(res2, {
    host: 'mail.example.com:465',
    user: 'user@example.com',
    password: 'pass#word',
    tls: 'true',
  });

  const uri3 = 'smtp://dev:secret@mailpit:1025';
  const res3 = parseSmtpUri(uri3);
  assert.deepEqual(res3, {
    host: 'mailpit:1025',
    user: 'dev',
    password: 'secret',
    tls: 'false',
  });
});

test('parseSmtpUri rejects invalid or malicious URIs', () => {
  assert.throws(() => parseSmtpUri(''), /missing or empty/);
  assert.throws(() => parseSmtpUri('http://smtp.example.com'), /Unsupported SMTP URI protocol/);
  assert.throws(() => parseSmtpUri('smtps://resend@smtp.resend.com:465'), /requires a password/);
  assert.throws(() => parseSmtpUri('smtps://:pass@smtp.resend.com:465'), /requires a username/);
  assert.throws(() => parseSmtpUri('smtps://user:pass@smtp.com\r\ninjection:465'), /control characters/);
});

test('validateEmailAddress validates standard emails and rejects malformed addresses', () => {
  assert.equal(validateEmailAddress('test@localhost'), false);
  assert.equal(validateEmailAddress('login@tjuclaw.agentwego.com'), true);
  assert.equal(validateEmailAddress('user+tag@domain.co.uk'), true);
  assert.equal(validateEmailAddress('invalid-email'), false);
  assert.equal(validateEmailAddress('foo@bar\n@baz.com'), false);
});

test('resolveAuthDevMailConfig defaults to captured Mailpit mode in non-dev mode', async () => {
  const root = '/any/path';
  const res1 = await resolveAuthDevMailConfig(root, {});
  assert.equal(res1.mode, 'captured');
  assert.equal(res1.composeEnv.ZITADEL_SMTP_HOST, 'mail:1025');
  assert.equal(res1.composeEnv.ZITADEL_SMTP_TLS, 'false');

  const res2 = await resolveAuthDevMailConfig(root, { AUTH_DEV_MAIL_MODE: 'captured' });
  assert.equal(res2.mode, 'captured');
  assert.equal(res2.composeEnv.ZITADEL_SMTP_HOST, 'mail:1025');
});

test('resolveAuthDevMailConfig in development mode auto-detects real SMTP when file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-mail-test-'));
  const envFile = join(dir, '.env.local');
  try {
    await writeFile(
      envFile,
      `COURIER_SMTP_CONNECTION_URI=smtps://resend:re_test_secret@smtp.resend.com:465/
COURIER_SMTP_FROM_ADDRESS=login@tjuclaw.agentwego.com
`
    );
    const res = await resolveAuthDevMailConfig(dir, { AUTH_DEV_SMTP_ENV_FILE: envFile }, { development: true });
    assert.equal(res.mode, 'real');
    assert.equal(res.smtp.host, 'smtp.resend.com:465');
    assert.equal(res.smtp.user, 'resend');
    assert.equal(res.smtp.password, 're_test_secret');
    assert.equal(res.smtp.tls, true);
    assert.equal(res.composeEnv.ZITADEL_SMTP_HOST, 'smtp.resend.com:465');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAuthDevMailConfig defaults to real mode in development and fails if SMTP file is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-mail-test-'));
  try {
    await assert.rejects(
      async () => resolveAuthDevMailConfig(dir, {}, { development: true }),
      /AUTH_DEV_MAIL_MODE=real requires an SMTP environment file/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAuthDevMailConfig strictly rejects real mode for disposable test runs', async () => {
  const root = '/any/path';
  await assert.rejects(
    async () => resolveAuthDevMailConfig(root, { AUTH_DEV_MAIL_MODE: 'real' }, { development: false }),
    /AUTH_DEV_MAIL_MODE=real is forbidden in disposable test mode/
  );
});

test('resolveAuthDevMailConfig rejects invalid AUTH_DEV_MAIL_MODE', async () => {
  const root = '/any/path';
  await assert.rejects(
    async () => resolveAuthDevMailConfig(root, { AUTH_DEV_MAIL_MODE: 'bogus' }),
    /Invalid AUTH_DEV_MAIL_MODE="bogus"/
  );
});

test('resolveAuthDevMailConfig fails closed if AUTH_DEV_MAIL_MODE=real and env file is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auth-mail-test-'));
  try {
    await assert.rejects(
      async () => resolveAuthDevMailConfig(root, { AUTH_DEV_MAIL_MODE: 'real' }, { development: true }),
      /AUTH_DEV_MAIL_MODE=real requires an SMTP environment file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveAuthDevMailConfig fails closed if required fields are missing in env file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-mail-test-'));
  const envFile = join(dir, '.env.local');
  try {
    await writeFile(envFile, 'COURIER_SMTP_CONNECTION_URI=smtps://user:pass@smtp.example.com:465\n');
    await assert.rejects(
      async () => resolveAuthDevMailConfig(dir, { AUTH_DEV_MAIL_MODE: 'real', AUTH_DEV_SMTP_ENV_FILE: envFile }, { development: true }),
      /requires COURIER_SMTP_FROM_ADDRESS/
    );

    await writeFile(envFile, 'COURIER_SMTP_FROM_ADDRESS=test@example.com\n');
    await assert.rejects(
      async () => resolveAuthDevMailConfig(dir, { AUTH_DEV_MAIL_MODE: 'real', AUTH_DEV_SMTP_ENV_FILE: envFile }, { development: true }),
      /requires COURIER_SMTP_CONNECTION_URI/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveAuthDevMailConfig successfully loads valid real SMTP configuration from env file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-mail-test-'));
  const envFile = join(dir, '.env.local');
  try {
    await writeFile(
      envFile,
      `COURIER_SMTP_CONNECTION_URI=smtps://resend:re_test_secret@smtp.resend.com:465/
COURIER_SMTP_FROM_ADDRESS=login@tjuclaw.agentwego.com
`
    );
    const res = await resolveAuthDevMailConfig(dir, {
      AUTH_DEV_MAIL_MODE: 'real',
      AUTH_DEV_SMTP_ENV_FILE: envFile,
    }, { development: true });
    assert.equal(res.mode, 'real');
    assert.deepEqual(res.composeEnv, {
      ZITADEL_SMTP_HOST: 'smtp.resend.com:465',
      ZITADEL_SMTP_USER: 'resend',
      ZITADEL_SMTP_PASSWORD: 're_test_secret',
      ZITADEL_SMTP_TLS: 'true',
      ZITADEL_SMTP_FROM: 'login@tjuclaw.agentwego.com',
      ZITADEL_SMTP_FROM_NAME: 'TJUClaw',
      ZITADEL_SMTP_REPLY_TO: 'login@tjuclaw.agentwego.com',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
