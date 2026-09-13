import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { isAbsolute, resolve } from 'node:path';

export function parseSimpleEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let [, key, val] = match;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function parseSmtpUri(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') {
    throw new Error('SMTP connection URI is missing or empty');
  }
  if (/[\r\n\0]/.test(rawUri)) {
    throw new Error('SMTP connection URI contains forbidden control characters');
  }
  let url;
  try {
    url = new URL(rawUri);
  } catch {
    throw new Error('SMTP connection URI is not a valid URL');
  }

  if (url.protocol !== 'smtps:' && url.protocol !== 'smtp:') {
    throw new Error(`Unsupported SMTP URI protocol "${url.protocol}"; expected "smtps:" or "smtp:"`);
  }
  const isTls = url.protocol === 'smtps:';
  const port = url.port || (isTls ? '465' : '25');
  const hostname = url.hostname;
  if (!hostname) {
    throw new Error('SMTP connection URI is missing a valid hostname');
  }

  const username = url.username ? decodeURIComponent(url.username) : '';
  const password = url.password ? decodeURIComponent(url.password) : '';

  if (!username) {
    throw new Error('SMTP connection URI requires a username');
  }
  if (!password) {
    throw new Error('SMTP connection URI requires a password');
  }

  return {
    host: `${hostname}:${port}`,
    user: username,
    password,
    tls: isTls ? 'true' : 'false',
  };
}

export function validateEmailAddress(address) {
  if (!address || typeof address !== 'string') return false;
  if (/[\r\n\0]/.test(address)) return false;
  const trimmed = address.trim();
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(trimmed);
}

export async function resolveAuthDevMailConfig(root, env = process.env, options = {}) {
  const isDev = options.development === true;
  const rawMode = env.AUTH_DEV_MAIL_MODE;

  // Disposable test runs MUST never run against real SMTP delivery.
  if (!isDev && rawMode && rawMode.trim().toLowerCase() === 'real') {
    throw new Error('AUTH_DEV_MAIL_MODE=real is forbidden in disposable test mode');
  }

  // In development, real SMTP is the default and must be explicitly configured.
  // Captured Mailpit delivery is an intentional opt-in via AUTH_DEV_MAIL_MODE=captured.
  let mode;
  if (rawMode) {
    mode = rawMode.trim().toLowerCase();
  } else if (isDev) {
    mode = 'real';
  } else {
    mode = 'captured';
  }

  if (mode === 'captured') {
    return {
      mode: 'captured',
      smtp: {
        auth: 'none',
        host: 'mail:1025',
        user: '',
        password: '',
        tls: false,
        fromAddress: 'test@localhost',
        fromName: 'TJUClaw',
        replyTo: 'test@localhost',
      },
      composeEnv: {
        ZITADEL_SMTP_HOST: 'mail:1025',
        ZITADEL_SMTP_USER: '',
        ZITADEL_SMTP_PASSWORD: '',
        ZITADEL_SMTP_TLS: 'false',
        ZITADEL_SMTP_FROM: 'test@localhost',
        ZITADEL_SMTP_FROM_NAME: 'TJUClaw',
        ZITADEL_SMTP_REPLY_TO: 'test@localhost',
      },
    };
  }

  if (mode !== 'real') {
    throw new Error(`Invalid AUTH_DEV_MAIL_MODE="${mode}"; must be "captured" or "real"`);
  }

  // mode === 'real': fail closed if anything is missing or malformed
  const envFile = env.AUTH_DEV_SMTP_ENV_FILE
    ? (isAbsolute(env.AUTH_DEV_SMTP_ENV_FILE) ? env.AUTH_DEV_SMTP_ENV_FILE : resolve(root, env.AUTH_DEV_SMTP_ENV_FILE))
    : resolve(root, 'ops/auth/.env.local');

  let fileContent;
  try {
    fileContent = await readFile(envFile, 'utf8');
  } catch (err) {
    throw new Error(`AUTH_DEV_MAIL_MODE=real requires an SMTP environment file: ${envFile} (${err.code || err.message}). Set AUTH_DEV_MAIL_MODE=captured only for offline/captured delivery.`);
  }

  const parsedEnv = parseSimpleEnv(fileContent);

  const rawUri = env.AUTH_DEV_SMTP_URI || parsedEnv.COURIER_SMTP_CONNECTION_URI || parsedEnv.SMTP_URI;
  if (!rawUri) {
    throw new Error(`AUTH_DEV_MAIL_MODE=real requires COURIER_SMTP_CONNECTION_URI in ${envFile} (or AUTH_DEV_SMTP_URI)`);
  }

  const smtp = parseSmtpUri(rawUri);

  const fromAddress = (env.AUTH_DEV_SMTP_FROM || parsedEnv.COURIER_SMTP_FROM_ADDRESS || parsedEnv.SMTP_FROM || '').trim();
  if (!fromAddress) {
    throw new Error(`AUTH_DEV_MAIL_MODE=real requires COURIER_SMTP_FROM_ADDRESS in ${envFile} (or AUTH_DEV_SMTP_FROM)`);
  }
  if (!validateEmailAddress(fromAddress)) {
    throw new Error(`AUTH_DEV_MAIL_MODE=real invalid from email address: "${fromAddress}"`);
  }

  const fromName = (env.AUTH_DEV_SMTP_FROM_NAME || parsedEnv.COURIER_SMTP_FROM_NAME || parsedEnv.SMTP_FROM_NAME || 'TJUClaw').trim();
  const replyTo = (env.AUTH_DEV_SMTP_REPLY_TO || parsedEnv.COURIER_SMTP_REPLY_TO || parsedEnv.SMTP_REPLY_TO || fromAddress).trim();
  if (!validateEmailAddress(replyTo)) {
    throw new Error(`AUTH_DEV_MAIL_MODE=real invalid reply-to email address: "${replyTo}"`);
  }

  return {
    mode: 'real',
    smtp: {
      auth: 'plain',
      host: smtp.host,
      user: smtp.user,
      password: smtp.password,
      tls: smtp.tls === 'true',
      fromAddress,
      fromName,
      replyTo,
    },
    composeEnv: {
      ZITADEL_SMTP_HOST: smtp.host,
      ZITADEL_SMTP_USER: smtp.user,
      ZITADEL_SMTP_PASSWORD: smtp.password,
      ZITADEL_SMTP_TLS: smtp.tls,
      ZITADEL_SMTP_FROM: fromAddress,
      ZITADEL_SMTP_FROM_NAME: fromName,
      ZITADEL_SMTP_REPLY_TO: replyTo,
    },
  };
}

function requestJson(baseUrl, path, token, hostHeader, { method = 'GET', body } = {}) {
  return new Promise((resolveReq, reject) => {
    const url = new URL(path, baseUrl);
    const postData = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {
      Authorization: `Bearer ${token}`,
      Host: hostHeader,
    };
    if (postData !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const req = http.request(url, { method, headers, timeout: 15000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = null;
        }
        resolveReq({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (postData !== undefined) {
      req.write(postData);
    }
    req.end();
  });
}

export async function syncZitadelSmtpProvider(baseUrl, token, hostHeader, smtpConfig) {
  if (!token) throw new Error('Missing ZITADEL PAT for SMTP synchronization');
  const auth = smtpConfig?.auth || 'plain';
  if (!smtpConfig || !smtpConfig.host || !smtpConfig.fromAddress) {
    throw new Error('Incomplete SMTP configuration for ZITADEL synchronization');
  }
  if (auth === 'plain' && (!smtpConfig.user || !smtpConfig.password)) {
    throw new Error('Incomplete authenticated SMTP configuration for ZITADEL synchronization');
  }
  if (auth !== 'plain' && auth !== 'none') {
    throw new Error(`Unsupported SMTP authentication mode: ${auth}`);
  }

  const createPayload = {
    senderAddress: smtpConfig.fromAddress,
    senderName: smtpConfig.fromName || 'TJUClaw',
    tls: Boolean(smtpConfig.tls),
    host: smtpConfig.host,
    user: smtpConfig.user || '',
    replyToAddress: smtpConfig.replyTo || smtpConfig.fromAddress,
    description: auth === 'none' ? 'Captured Mailpit SMTP' : 'Configured SMTP',
    [auth]: auth === 'none' ? {} : { password: smtpConfig.password },
  };
  const { status: createStatus, body: createResp } = await requestJson(
    baseUrl,
    '/admin/v1/email/smtp',
    token,
    hostHeader,
    { method: 'POST', body: createPayload }
  );
  if (createStatus !== 200 || !createResp?.id) {
    throw new Error(`Failed to create SMTP provider (HTTP ${createStatus})`);
  }

  const newId = createResp.id;
  const { status: actStatus } = await requestJson(
    baseUrl,
    `/admin/v1/smtp/${newId}/_activate`,
    token,
    hostHeader,
    { method: 'POST', body: {} }
  );
  if (actStatus !== 200) {
    throw new Error(`Failed to activate SMTP provider ${newId} (HTTP ${actStatus})`);
  }

  return { changed: true, id: newId, status: 'created_and_activated' };
}
