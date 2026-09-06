import { expect, test } from '@playwright/test';

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 1000]]) {
  test(`auth audit comparison and navigation ${width}`, async ({ page }, info) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.locator('.tabs').getByRole('button', { name: '邮箱登录', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('页面状态')).toHaveValue('login');
    await expect(page.getByAltText('邮箱登录 · 手机 · light')).toBeVisible();
    await expect.poll(() => page.locator('.auth-review .picture img').evaluateAll(images =>
      images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('login-audit.png'), fullPage: true });
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.getByAltText('邮箱登录 · 手机 · dark')).toBeVisible();
    await page.getByRole('button', { name: '叠加检查', exact: true }).click();
    await page.getByRole('slider', { name: '登录实现图透明度' }).fill('35');
    await expect(page.getByAltText('登录实现叠加图')).toHaveCSS('opacity', '0.35');
    await page.getByRole('button', { name: '回到并排' }).click();
    await page.getByRole('button', { name: '放大：邮箱登录 · 手机 · dark', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '请求过于频繁 小屏 深色', exact: true }).click();
    await expect(page.getByLabel('页面状态')).toHaveValue('rate-limit');
    await expect(page.locator('.auth-state-heading')).toContainText('注入异常测试');
    await expect(page.getByRole('heading', { name: '这是产品新增状态。' })).toBeVisible();
    await expect(page.getByRole('button', { name: '叠加检查' })).toBeDisabled();
    await page.getByLabel('页面状态').selectOption('login');
    await page.getByRole('button', { name: '查看逐图描述' }).click();
    await expect(page.getByRole('heading', { name: '逐图观察' })).toBeVisible();
    await page.locator('.tabs').getByRole('button', { name: '邮箱登录', exact: true }).click();
    await expect(page.getByLabel('页面状态')).toHaveValue('login');
    expect(errors).toEqual([]);
  });
}

test('missing auth evidence gives a recovery command rather than a fake pass', async ({ page }) => {
  await page.route('**/__audit/auth', route => route.fulfill({ status: 404, body: 'Missing' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('task audit:auth');
});
