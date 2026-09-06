import { expect, test } from '@playwright/test';

const key = 'tjuclaw.appearance.v1';
const root = page => page.locator('html');
const choice = (page, name) => page.getByRole('radio', { name, exact: true });
const select = async (page, name) => {
  await page.locator('.appearance-choice').filter({ has: choice(page, name) }).click();
  await expect(choice(page, name)).toBeChecked();
};

test('appearance persists, follows the OS only in system mode, and resets', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/preview/appearance');
  await expect(choice(page, '跟随系统')).toBeChecked();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await select(page, '浅色');
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await select(page, '蓝色');
  await expect(root(page)).toHaveAttribute('data-accent', 'blue');
  await page.reload();
  await expect(choice(page, '浅色')).toBeChecked();
  await expect(choice(page, '蓝色')).toBeChecked();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect(choice(page, '跟随系统')).toBeChecked();
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await expect(root(page)).toHaveAttribute('data-accent', 'mono');
  expect(errors).toEqual([]);
});

test('preferences synchronize between tabs, and tolerate invalid storage', async ({ page, context }) => {
  await page.goto('/preview/appearance');
  const second = await context.newPage();
  await second.goto('/preview/appearance');
  await select(page, '深色');
  await select(page, '蓝色');
  await expect(root(second)).toHaveAttribute('data-theme', 'dark');
  await expect(choice(second, '蓝色')).toBeChecked();
  await page.evaluate(key => localStorage.setItem(key, '{invalid'), key);
  await expect(root(second)).toHaveAttribute('data-theme', 'light');
  await expect(root(second)).toHaveAttribute('data-accent', 'mono');
  await page.reload();
  await expect(choice(page, '跟随系统')).toBeChecked();
  await second.close();
});

test('storage denial does not prevent in-memory theme changes', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  });
  await page.goto('/preview/appearance');
  await select(page, '深色');
  await select(page, '蓝色');
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await expect(root(page)).toHaveAttribute('data-accent', 'blue');
});

test('dialog keyboard navigation, focus restoration and example interactions', async ({ page }) => {
  await page.goto('/preview/appearance');
  await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(choice(page, '跟随系统')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(choice(page, '浅色')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开外观设置', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '设置外观', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '设置外观', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '搜索示例', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索示例' }).fill('不存在的示例');
  await expect(page.getByText('没有匹配的示例，换个关键词试试。')).toBeVisible();
  await page.getByRole('button', { name: '清空搜索' }).click();
  await expect(page.locator('.conversation-list li')).toHaveCount(3);
  await page.getByRole('button', { name: '调整外观' }).click();
  await page.getByRole('button', { name: /今日灵感.md/ }).click();
  await expect(page.locator('.sample-document')).toBeVisible();
});

for (const theme of ['浅色', '深色']) {
  test(`search focus follows its rounded container in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/preview/appearance');
    await select(page, theme);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '搜索示例', exact: true }).click();
    const input = page.getByRole('textbox', { name: '搜索示例' });
    const field = page.locator('.sample-search');
    await input.click();
    await input.fill('笔记');
    await expect(input).toBeFocused();
    await expect(input).toHaveCSS('outline-style', 'none');
    await expect(field).toHaveCSS('border-radius', '16px');
    await expect(field).not.toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.conversation-list li')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('search-focus.png') });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '清空搜索' })).toBeFocused();
    await expect(field).not.toHaveCSS('box-shadow', 'none');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('');
    await page.keyboard.press('Tab');
    await expect(field).toHaveCSS('box-shadow', 'none');
  });
}

test('search focus remains visible in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/preview/appearance');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '搜索示例', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索示例' })).toBeFocused();
  await expect(page.locator('.sample-search')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.sample-search')).toHaveCSS('outline-width', '2px');
  await expect(page.locator('html')).toHaveCSS('scrollbar-color', 'auto');
});

test('thin scrollbars preserve real dialog and document scrolling', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto('/preview/appearance');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const readScrollbar = () => dialog.evaluate(el => ({
    width: getComputedStyle(el, '::-webkit-scrollbar').width,
    radius: getComputedStyle(el, '::-webkit-scrollbar-thumb').borderRadius,
    thumb: getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor,
    track: getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor,
    button: getComputedStyle(el, '::-webkit-scrollbar-button').display,
  }));
  const light = await readScrollbar();
  expect(light.width).toBe('8px');
  expect(light.radius).toBe('999px');
  expect(light.track).toBe('rgba(0, 0, 0, 0)');
  expect(light.button).toBe('none');
  await dialog.hover();
  await page.mouse.wheel(0, 350);
  await expect.poll(() => dialog.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('scrollbar-light.png') });
  await select(page, '深色');
  expect((await readScrollbar()).thumb).not.toBe(light.thumb);
  await page.screenshot({ path: info.outputPath('scrollbar-dark.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 480 });
  await page.mouse.move(190, 300);
  await page.mouse.wheel(0, 350);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
});

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 900]]) {
  for (const theme of ['浅色', '深色']) {
    test(`${width}x${height} ${theme} layout and visual capture`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.goto('/preview/appearance');
      await select(page, theme);
      if (theme === '深色') await select(page, '蓝色');
      await expect(page.getByRole('dialog')).toBeVisible();
      const bounds = await page.getByRole('dialog').boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('button', { name: '恢复默认' })).toBeInViewport();
      await page.getByRole('heading', { name: '外观', exact: true }).focus();
      await page.screenshot({ path: info.outputPath('appearance.png') });
    });
  }
}
