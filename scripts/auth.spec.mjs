import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function captureState(page, info, state, evidence = 'real-kratos') {
  const original = page.viewportSize();
  for (const [viewport, width, height] of [['compact', 360, 800], ['phone', 390, 844], ['tablet', 768, 1024], ['desktop', 1440, 900]]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const name = `audit-${state}-${viewport}-${theme}`;
      // Mask codes even in synthetic accounts; evidence never needs a usable OTP.
      await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled',
        mask: [page.getByLabel('邮箱验证码', { exact: true })] });
      await writeFile(info.outputPath(`${name}.json`), JSON.stringify({
        state, viewport, theme, width, height, evidence, capturedAt: new Date().toISOString(),
      }));
    }
  }
  await page.setViewportSize(original);
  await page.emulateMedia({ colorScheme: 'light' });
}

async function latestCode(request, email, previousID) {
  let message;
  await expect.poll(async () => {
    const result = await request.get('http://127.0.0.1:18026/api/v1/messages');
    const { messages } = await result.json();
    const excluded = Array.isArray(previousID) ? previousID : [previousID];
    message = messages.find(m => m.To.some(to => to.Address === email) && !excluded.includes(m.ID));
    return !!message;
  }, { timeout: 20000 }).toBe(true);
  const result = await request.get(`http://127.0.0.1:18026/api/v1/message/${message.ID}`);
  const mail = await result.json();
  const code = mail.Text.match(/\b[0-9]{6}\b/)?.[0];
  expect(code, 'Kratos must deliver a real six-digit code').toBeTruthy();
  return { code, id: message.ID };
}

test('real email registration, wrong code, reload, session, logout and login', async ({ page, request, context }, info) => {
  test.setTimeout(120000);
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto('/auth/registration');
  await page.getByLabel('邮箱地址', { exact: true }).fill(email);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await captureState(page, info, 'registration-code');
  const mail = await latestCode(request, email);
  const wrong = mail.code === '000000' ? '111111' : '000000';
  await page.getByLabel('邮箱验证码', { exact: true }).fill(wrong);
  await page.getByRole('button', { name: '验证并创建账号' }).click();
  await expect(page.getByRole('alert')).toContainText('验证码');
  await captureState(page, info, 'wrong-code');
  await page.reload();
  await page.getByRole('button', { name: '重新发送验证码', exact: true }).click();
  const resent = await latestCode(request, email, mail.id);
  await expect(page.getByRole('button', { name: /秒后可重发/ })).toBeDisabled();
  await captureState(page, info, 'resend');
  await page.getByLabel('邮箱验证码', { exact: true }).fill(mail.code);
  await page.getByRole('button', { name: '验证并创建账号' }).click();
  await expect(page.getByRole('alert')).toContainText('验证码');
  await page.getByLabel('邮箱验证码', { exact: true }).fill(resent.code);
  await page.getByRole('button', { name: '验证并创建账号' }).click();
  await expect(page.getByRole('heading', { name: '准备好了。' })).toBeVisible();
  await page.goto('/auth/login');
  await expect(page.getByRole('heading', { name: '准备好了。' })).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.some(c => c.httpOnly && c.name.includes('session'))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).every(key => key === 'tjuclaw.appearance.v1'))).toBe(true);
  const session = await page.request.get('/api/auth/session');
  expect(session.status()).toBe(200);
  expect(await session.json()).toMatchObject({ email, email_verified: true });
  await captureState(page, info, 'complete');
  await page.getByRole('link', { name: '进入 TJUClaw' }).click();
  await expect(page.getByRole('heading', { name: '你的账号。' })).toBeVisible();
  await page.reload();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await captureState(page, info, 'account');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已安全退出。' })).toBeVisible();
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  await page.goto('/auth/login');
  await page.getByLabel('邮箱地址', { exact: true }).fill(email);
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await captureState(page, info, 'login-code');
  const loginMail = await latestCode(request, email, [mail.id, resent.id]);
  await page.getByLabel('邮箱验证码', { exact: true }).fill(loginMail.code);
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page.getByRole('heading', { name: '准备好了。' })).toBeVisible();
});

test('protected page rejects guests and Kratos rejects missing CSRF', async ({ page, request }) => {
  await page.goto('/app');
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/login/);
  const flowResponse = await request.get('/api/kratos/self-service/registration/browser');
  const flow = await flowResponse.json();
  const response = await request.post(`/api/kratos/self-service/registration?flow=${flow.id}`, {
    headers: { Origin: 'http://127.0.0.1:1423' },
    data: { method: 'code', traits: { email: 'csrf-check@example.com' } },
  });
  expect(response.status()).toBe(403);
});

test('expired link and network outage have recoverable UI', async ({ page }, info) => {
  await page.goto('/auth/login?flow=00000000-0000-0000-0000-000000000000');
  await expect(page.getByRole('alert')).toContainText('失效');
  await captureState(page, info, 'expired');
  await page.getByRole('button', { name: '重新开始' }).click();
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
  await page.route('**/api/kratos/**', route => route.abort());
  await page.goto('/auth/registration');
  await expect(page.getByRole('alert')).toContainText('连接不上');
  await captureState(page, info, 'offline', 'injected-response');
  await page.unroute('**/api/kratos/**');
  await page.getByRole('button', { name: '重新开始' }).click();
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
});

test('rate limits and expired submissions never claim success', async ({ page }, info) => {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱地址', { exact: true }).fill('rate-test@example.com');
  await page.route('**/api/kratos/self-service/login?flow=*', route => route.fulfill({
    status: 429, contentType: 'text/html', body: '<h1>Too many requests</h1>',
  }));
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('频繁');
  await captureState(page, info, 'rate-limit', 'injected-response');
  await page.unroute('**/api/kratos/self-service/login?flow=*');
  await page.route('**/api/kratos/self-service/login?flow=*', route => route.fulfill({
    status: 410, contentType: 'application/json', body: '{"error":{"id":"self_service_flow_expired"}}',
  }));
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('过期');
  await expect(page.getByRole('button', { name: '重新开始' })).toBeVisible();
  await captureState(page, info, 'expired-submit', 'injected-response');
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
});

test('malformed upstream responses fail gracefully instead of crashing', async ({ page }) => {
  await page.route('**/api/kratos/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));
  await page.goto('/auth/login');
  await expect(page.getByRole('alert')).toContainText('不可用');
  await page.route('**/api/auth/session', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<html>Misconfigured proxy</html>',
  }));
  await page.goto('/app');
  await expect(page.getByRole('alert')).toContainText('不可用');
});

test('verification flow sends and rejects invalid code without claiming success', async ({ page }, info) => {
  await page.goto('/auth/verification');
  await page.getByLabel('邮箱地址', { exact: true }).fill('nonexistent@example.com');
  await page.getByRole('button', { name: '发送验证码' }).click();
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await captureState(page, info, 'verification-code');
  await page.getByLabel('邮箱验证码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '验证邮箱', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('验证码');
  await expect(page.getByRole('heading', { name: '邮箱已验证。' })).toHaveCount(0);
  await captureState(page, info, 'verification-error');
});

test('audit route inventory', async ({ page }, info) => {
  test.setTimeout(120000);
  for (const [state, route] of [
    ['welcome', '/'], ['login', '/auth/login'], ['registration', '/auth/registration'],
    ['verification', '/auth/verification'], ['help', '/auth/help'],
    ['error', '/auth/error'], ['logged-out', '/auth/logged-out'],
  ]) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (['login', 'registration', 'verification'].includes(state)) {
      await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
    }
    await captureState(page, info, state, 'render');
  }
});

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 900]]) {
  for (const theme of ['light', 'dark']) {
    test(`auth ${width}x${height} ${theme} layout`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      for (const route of ['/', '/auth/login', '/auth/registration', '/auth/help', '/auth/error', '/auth/logged-out']) {
        await page.goto(route);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        if (route === '/auth/login' || route === '/auth/registration') await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`${route.replaceAll('/', '-') || 'welcome'}.png`), fullPage: true });
      }
    });
  }
}
