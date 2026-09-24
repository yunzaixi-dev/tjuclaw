import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:1423';
const headers = { Origin: origin };
const nginx = await readFile(new URL('../ops/images/nginx.conf', import.meta.url), 'utf8');
const csp = nginx.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
if (!csp) throw new Error('Missing production CSP');

async function captureState(page, info, state, evidence = 'real-zitadel-cap') {
  const original = page.viewportSize();
  for (const [viewport, width, height] of [['compact', 360, 800], ['phone', 390, 844], ['tablet', 768, 1024], ['desktop', 1440, 900]]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const name = `audit-${state}-${viewport}-${theme}`;
      await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled', mask: [page.getByLabel('邮箱验证码', { exact: true })] });
      await writeFile(info.outputPath(`${name}.json`), JSON.stringify({ state, viewport, theme, width, height, evidence, capturedAt: new Date().toISOString() }));
    }
  }
  await page.setViewportSize(original);
  await page.emulateMedia({ colorScheme: 'light' });
}
async function latestCode(request, email, previous = []) {
  let message;
  await expect.poll(async () => {
    const { messages } = await (await request.get('http://127.0.0.1:18026/api/v1/messages')).json();
    message = messages.find(item => item.To.some(to => to.Address === email) && !previous.includes(item.ID));
    return Boolean(message);
  }, { timeout: 30000 }).toBe(true);
  const mail = await (await request.get(`http://127.0.0.1:18026/api/v1/message/${message.ID}`)).json();
  const code = (mail.Text || mail.HTML || '').match(/\b[0-9]{6}\b/)?.[0];
  expect(Boolean(code), 'ZITADEL must deliver a real six-digit email code').toBe(true);
  return { code, id: message.ID };
}
async function solveCap(page) {
  await page.getByRole('button', { name: '安全验证', exact: true }).click();
  await expect(page.getByRole('button', { name: '安全验证已通过', exact: true })).toBeVisible({ timeout: 60000 });
}
async function begin(page, email, route = '/auth/login') {
  await page.goto(route);
  await page.getByLabel('邮箱地址', { exact: true }).fill(email);
  await expect(page.getByRole('button', { name: '获取验证码', exact: true })).toBeDisabled();
  await solveCap(page);
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith('/api/auth/start')),
    page.getByRole('button', { name: '获取验证码', exact: true }).click(),
  ]);
  expect(response.status(), 'real Cap-gated email start must succeed').toBe(200);
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
}
const workspacePassphrases = new Map();
async function finish(page, code, email) {
  await page.getByLabel('邮箱验证码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.locator('.sidebar-library-button, .workspace-vault-screen').first()).toBeVisible({ timeout: 30000 });
  const firstWorkspace = page.getByRole('heading', { name: '创建工作空间', exact: true });
  if (await firstWorkspace.isVisible().catch(() => false)) {
    const passphrase = `TJUClaw-e2e-${Date.now()}`;
    workspacePassphrases.set(email, passphrase);
    await page.getByLabel('工作空间名称', { exact: true }).fill('我的知识库');
    await page.getByLabel('创建工作区口令', { exact: true }).fill(passphrase);
    await page.getByLabel('再次输入口令', { exact: true }).fill(passphrase);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '创建并下载备份', exact: true }).click();
    await expect(page.getByRole('heading', { name: '口令已创建', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '我已安全备份，进入工作区', exact: true }).click();
  } else {
    const unlockWorkspace = page.getByRole('heading', { name: '解锁工作区', exact: true });
    if (await unlockWorkspace.isVisible().catch(() => false)) {
      const passphrase = workspacePassphrases.get(email);
      expect(passphrase, `missing workspace passphrase for ${email}`).toBeTruthy();
      await page.getByLabel('工作区口令', { exact: true }).fill(passphrase);
      await page.getByRole('button', { name: '解锁进入工作区', exact: true }).click();
    }
  }
  const libraryButton = page.locator('.sidebar-library-button');
  await expect(libraryButton).toBeVisible();
  await expect(libraryButton).toContainText('个文件');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('button', { name: '新手向导', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '资料夹', exact: true }).click();
  await expect(libraryButton).toBeVisible();
}

test('real session survives a workspace refresh', async ({ page, request }) => {
  test.setTimeout(120000);
  const email = `refresh-${Date.now()}@example.com`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  await page.reload();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.locator('.sidebar-library-button')).toBeVisible();
  await expect(page.locator('.sidebar-library-button')).toContainText('个文件');
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  await page.goto('/auth/login');
  await expect(page).toHaveURL(/\/workspace$/);
  await page.reload();
  await expect(page).toHaveURL(/\/workspace$/);
});

test('real Cap under production CSP, enrollment, wrong code, resend, reload, login and provider logout', async ({ page, request, context }, info) => {
  test.setTimeout(240000);
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push(event.violatedDirective));
  });
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
  });
  const email = `e2e-${Date.now()}@example.com`;
  let usedCap;
  page.on('request', req => { if (req.url().endsWith('/api/auth/start')) usedCap = req.postDataJSON()?.captcha_token; });
  await begin(page, email, '/auth/registration');
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  const token = usedCap;
  expect(Boolean(token)).toBe(true);
  expect((await page.request.post('/api/auth/start', { headers, data: { email, captcha_token: token } })).status()).toBe(403);
  expect((await page.request.get('/api/tasks')).status()).toBe(401);
  await captureState(page, info, 'registration-code');
  const mail = await latestCode(request, email);
  await page.getByLabel('邮箱验证码', { exact: true }).fill(mail.code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('验证码不正确');
  await captureState(page, info, 'wrong-code');
  await page.reload();
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '重新发送', exact: true }).click({ timeout: 70000 });
  await solveCap(page);
  await page.getByRole('button', { name: '确认重发', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('新验证码已发送');
  const resent = await latestCode(request, email, [mail.id]);
  await captureState(page, info, 'resend');
  await finish(page, resent.code, email);
  const sessionCookie = (await context.cookies()).find(cookie => cookie.name.includes('session'));
  expect(Boolean(sessionCookie?.httpOnly)).toBe(true);
  expect(sessionCookie.sameSite).toBe('Lax');
  const session = await page.request.get('/api/auth/session');
  expect(session.status()).toBe(200);
  expect(await session.json()).toMatchObject({ email, email_verified: true });
  expect(await page.evaluate(() => Object.keys(localStorage).every(key =>
    key === 'tjuclaw.appearance.v1'
    || key === 'tjuclaw.contest-banner.v1'
    || key.startsWith('tjuclaw.workspace.vault.v1.')
  ))).toBe(true);
  await page.goto('/auth/complete');
  await expect(page.getByRole('heading', { name: '已安全登录。' })).toBeVisible();
  await captureState(page, info, 'complete');
  await captureState(page, info, 'account');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已安全退出。' })).toBeVisible();
  await context.addCookies([sessionCookie]);
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  await context.clearCookies();
  await begin(page, email);
  await captureState(page, info, 'login-code');
  const loginMail = await latestCode(request, email, [mail.id, resent.id]);
  await finish(page, loginMail.code);
});

test('real library persistence and cross-identity isolation', async ({ page, request, context }) => {
  test.setTimeout(180000);
  const emailA = `lib-a-${Date.now()}@example.com`;
  await begin(page, emailA);
  await finish(page, (await latestCode(request, emailA)).code, emailA);
  const title = `Note for user A ${Date.now()}`;
  const body = 'Details owned by A';
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await expect(page.getByLabel('正文', { exact: true })).toBeVisible();
  await page.getByLabel('标题', { exact: true }).fill(title);
  await expect(page.getByRole('treeitem', { name: title })).toBeVisible();
  await page.getByLabel('正文', { exact: true }).fill(body);
  let note;
  await expect.poll(async () => {
    const { libraries } = await (await page.request.get('/api/libraries')).json();
    for (const lib of libraries || []) {
      const { entries } = await (await page.request.get(`/api/libraries/${lib.id}/entries`)).json();
      const found = entries?.find(item => item.title === title);
      if (!found?.id) continue;
      const { entry } = await (await page.request.get(`/api/entries/${found.id}`)).json();
      if (entry?.body === body) {
        note = { libraryId: lib.id, id: found.id };
        return true;
      }
    }
    return false;
  }).toBe(true);

  await page.reload();
  await page.getByRole('treeitem', { name: title }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue(body);
  expect((await page.request.post('/api/auth/logout', { headers, data: {} })).status()).toBe(204);
  await context.clearCookies();
  const emailB = `lib-b-${Date.now()}@example.com`;
  await begin(page, emailB);
  await finish(page, (await latestCode(request, emailB)).code, emailB);
  const foreign = await page.request.get(`/api/entries/${note.id}`);
  const missing = await page.request.get(`/api/entries/${'0'.repeat(32)}`);
  expect(foreign.status()).toBe(404);
  expect(missing.status()).toBe(404);
  expect(await foreign.json()).toEqual(await missing.json());
  expect((await page.request.get(`/api/libraries/${note.libraryId}`)).status()).toBe(404);
  const { libraries } = await (await page.request.get('/api/libraries')).json();
  expect(libraries.map(item => item.id)).not.toContain(note.libraryId);
  await expect(page.getByRole('treeitem', { name: title })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('button', { name: '新手向导', exact: true })).toBeVisible();
});


test('guests, cross-origin sends and missing or invalid Cap are rejected', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/auth\/login$/);
  const data = { email: 'captcha-gate@example.com', captcha_token: '' };
  expect((await page.request.post('/api/auth/start', { data })).status()).toBe(403);
  expect((await page.request.post('/api/auth/start', { headers: { Origin: 'https://other.invalid' }, data })).status()).toBe(403);
  expect((await page.request.post('/api/auth/start', { headers, data })).status()).toBe(403);
  expect((await page.request.post('/api/auth/start', { headers, data: { ...data, captcha_token: 'invalid' } })).status()).toBe(403);
  expect((await page.request.post('/api/auth/verify', { headers, data: { code: '000000' } })).status()).toBe(410);
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
});

test('lost pending cookie has recoverable expiry without authentication', async ({ page, context }, info) => {
  test.setTimeout(120000);
  await begin(page, `expired-${Date.now()}@example.com`, '/auth/verification');
  await captureState(page, info, 'verification-code');
  await context.clearCookies();
  await page.getByLabel('邮箱验证码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('过期');
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  await captureState(page, info, 'verification-error');
  await captureState(page, info, 'expired');
  await captureState(page, info, 'expired-submit');
  await page.getByRole('button', { name: '重新开始', exact: true }).click();
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
});

test('network and malformed response errors recover without replacing the form', async ({ page }, info) => {
  await page.route('**/api/auth/flow', route => route.abort());
  await page.goto('/auth/login');
  await expect(page.getByRole('alert')).toContainText('暂时连接不上认证服务');
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
  await captureState(page, info, 'offline', 'injected-response');
  await page.unroute('**/api/auth/flow');
  await page.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.route('**/api/auth/flow', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('暂时连接不上认证服务');
  await page.route('**/api/auth/session', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>bad proxy</html>' }));
  await page.goto('/app');
  await expect(page.getByRole('alert')).toContainText('暂时连接不上认证服务');
});

test('rate limit response remains an error after real Cap solving', async ({ page }, info) => {
  test.setTimeout(120000);
  await page.route('**/api/auth/start', route => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":{"id":"rate_limited"}}' }));
  await page.goto('/auth/login');
  await page.getByLabel('邮箱地址', { exact: true }).fill('rate-test@example.com');
  await solveCap(page);
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('频繁');
  await captureState(page, info, 'rate-limit', 'injected-response');
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
});

test('auth route inventory and responsive evidence', async ({ page }, info) => {
  test.setTimeout(120000);
  for (const [state, route] of [['welcome', '/'], ['login', '/auth/login'], ['registration', '/auth/registration'], ['verification', '/auth/verification'], ['help', '/auth/help'], ['error', '/auth/error'], ['logged-out', '/auth/logged-out']]) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await captureState(page, info, state, 'render');
  }
});
