import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Exercises the actual running `task dev` proxy and captured local mailbox.
// Reuse a synthetic address so repeat runs also cover existing-user login.
const directory = new URL('../test-results/auth-dev/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const accountFile = new URL('account.json', directory);
let email;
try { ({ email } = JSON.parse(await readFile(accountFile, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!email) {
  email = `dev-smoke-${Date.now()}@example.com`;
  await writeFile(accountFile, JSON.stringify({ email }), { mode: 0o600 });
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const mailBase = 'http://127.0.0.1:18027';
  const before = await (await page.request.get(`${mailBase}/api/v1/messages`)).json();
  const previous = new Set(before.messages.map(item => item.ID));
  await page.goto('http://127.0.0.1:1420/auth/login');
  await expect(page.getByLabel('邮箱地址', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('邮箱地址', { exact: true }).fill(email);
  await page.getByRole('button', { name: '安全验证', exact: true }).click();
  await expect(page.getByRole('button', { name: '安全验证已通过', exact: true })).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: '获取验证码', exact: true }).click();
  await expect(page.getByLabel('邮箱验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  let message;
  await expect.poll(async () => {
    const { messages } = await (await page.request.get(`${mailBase}/api/v1/messages`)).json();
    message = messages.find(item => !previous.has(item.ID) && item.To.some(to => to.Address === email));
    return Boolean(message);
  }, { timeout: 30000 }).toBe(true);
  const mail = await (await page.request.get(`${mailBase}/api/v1/message/${message.ID}`)).json();
  const code = (mail.Text || mail.HTML || '').match(/\b[0-9]{6}\b/)?.[0];
  assert.ok(code, 'Captured ZITADEL email contains an OTP');
  await page.getByLabel('邮箱验证码', { exact: true }).fill(code);
  await page.getByRole('button', { name: '验证并继续', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  assert.equal((await page.request.get('http://127.0.0.1:1420/api/auth/session')).status(), 200);
  await page.reload();
  await expect(page.getByRole('heading', { name: '任务工作区', exact: true })).toBeVisible();
  const logout = await page.request.post('http://127.0.0.1:1420/api/auth/logout', { data: {}, headers: { Origin: 'http://127.0.0.1:1420' } });
  assert.equal(logout.status(), 204);
  assert.equal((await page.request.get('http://127.0.0.1:1420/api/auth/session')).status(), 401);
  await page.goto('http://127.0.0.1:1420/auth/login');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: new URL('login.png', directory).pathname });
  console.log('PASS: running dev proxy, real Cap, captured email, login, reload and logout');
} finally { await browser.close(); }
