import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:1423';
const headers = { Origin: origin };
const nginx = await readFile(new URL('../ops/images/nginx.conf', import.meta.url), 'utf8');
const csp = nginx.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
if (!csp) throw new Error('Missing production CSP');

async function captureState(page, info, state, evidence = 'real-kratos-cap') {
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
  expect(Boolean(code), 'Kratos must deliver a real six-digit email code').toBe(true);
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

async function unlockIfNeeded(page, email) {
  await expect(page.locator('.sidebar-library-button, .workspace-vault-screen').first()).toBeVisible();
  if (!await page.getByRole('heading', { name: '解锁工作区', exact: true }).isVisible().catch(() => false)) return;
  const passphrase = workspacePassphrases.get(email);
  expect(passphrase, `missing workspace passphrase for ${email}`).toBeTruthy();
  await page.getByLabel('工作区口令', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: '解锁进入工作区', exact: true }).click();
  await expect(page.locator('.sidebar-library-button')).toBeVisible();
}

test('real session survives a workspace refresh', async ({ page, request }) => {
  test.setTimeout(120000);
  const email = `refresh-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  await page.reload();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.locator('.sidebar-library-button')).toBeVisible();
  await expect(page.locator('.sidebar-library-button')).toContainText('个文件');
  expect((await page.request.get('/api/auth/session')).status()).toBe(200);
  // A signed-in visitor sees the account and chooses; the login page no longer redirects.
  await page.goto('/auth/login');
  await expect(page.getByRole('heading', { name: '你已登录' })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '进入工作区' }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.reload();
  await expect(page).toHaveURL(/\/workspace$/);
});

test('real note graph loads linked bodies from authorized entry details', async ({ page, request }) => {
  test.setTimeout(120000);
  const email = `graph-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  const { libraries } = await (await page.request.get('/api/libraries')).json();
  const libraryId = libraries.find(library => library.role === 'owner')?.id;
  expect(libraryId).toBeTruthy();
  const sourceTitle = `Graph source ${Date.now()}`;
  const targetTitle = `Graph target ${Date.now()}`;
  for (const [title, body] of [[sourceTitle, `[[${targetTitle}]]`], [targetTitle, 'Linked note body']]) {
    const response = await page.request.post(`/api/libraries/${libraryId}/entries`, {
      headers, data: { kind: 'note', title, body },
    });
    expect(response.status()).toBe(201);
  }
  const { entries } = await (await page.request.get(`/api/libraries/${libraryId}/entries`)).json();
  expect(entries.find(entry => entry.title === sourceTitle)?.body).toBeFalsy();
  await page.reload();
  await page.getByRole('button', { name: '知识图谱', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('2 篇笔记 · 1 条双向链接')).toBeVisible();
  await expect(page.locator('.graph-edge')).toHaveCount(1);
  await page.getByRole('button', { name: `打开笔记 ${targetTitle}` }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveText('Linked note body');
});

test('real file upload previews and downloads persisted bytes only for its owner', async ({ page, request, context }) => {
  test.setTimeout(180000);
  const emailA = `file-a-${Date.now()}@tju.edu.cn`;
  await begin(page, emailA);
  await finish(page, (await latestCode(request, emailA)).code, emailA);
  const { libraries } = await (await page.request.get('/api/libraries')).json();
  const libraryId = libraries.find(library => library.role === 'owner')?.id;
  expect(libraryId).toBeTruthy();
  const name = `diagram-${Date.now()}.png`;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==', 'base64');
  const [uploaded] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/libraries/${libraryId}/files`) && response.request().method() === 'POST'),
    page.getByLabel('上传课程资料').setInputFiles({ name, mimeType: 'image/png', buffer: bytes }),
  ]);
  expect(uploaded.status()).toBe(201);
  const { entry } = await uploaded.json();
  expect(entry).toMatchObject({ library_id: libraryId, kind: 'file', title: name, content_type: 'image/png', size: bytes.length });
  expect(entry.object_id).toBeUndefined();
  await expect(page.locator('.file-preview-pane img')).toHaveAttribute('alt', name);
  const path = `/api/entries/${entry.id}/file`;
  const original = await page.request.get(path);
  expect(original.status()).toBe(200);
  expect(original.headers()['content-type']).toContain('image/png');
  expect(original.headers()['content-disposition']).toContain('attachment');
  expect(original.headers()['cache-control']).toBe('no-store');
  expect(await original.body()).toEqual(bytes);
  const noteResponse = await page.request.post(`/api/libraries/${libraryId}/entries`, {
    headers, data: { kind: 'note', title: 'Not a folder', body: '' },
  });
  expect(noteResponse.status()).toBe(201);
  const { entry: note } = await noteResponse.json();
  const invalidParent = await page.request.post(`/api/libraries/${libraryId}/files`, {
    headers, multipart: { file: { name, mimeType: 'image/png', buffer: bytes }, parent_id: note.id },
  });
  expect(invalidParent.status()).toBe(400);
  const folderResponse = await page.request.post(`/api/libraries/${libraryId}/folders`, {
    headers, data: { title: 'File attachments' },
  });
  expect(folderResponse.status()).toBe(201);
  const { folder } = await folderResponse.json();
  const nestedUpload = await page.request.post(`/api/libraries/${libraryId}/files`, {
    headers, multipart: { file: { name: 'nested.png', mimeType: 'image/png', buffer: bytes }, parent_id: folder.id },
  });
  expect(nestedUpload.status()).toBe(201);
  const { entry: nested } = await nestedUpload.json();
  expect(nested.parent_id).toBe(folder.id);
  expect(await (await page.request.get(`/api/entries/${nested.id}/file`)).body()).toEqual(bytes);

  await page.reload();
  await unlockIfNeeded(page, emailA);
  await page.getByRole('treeitem', { name }).click();
  await expect(page.locator('.file-preview-pane img')).toHaveAttribute('alt', name);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载原件' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
  expect((await (await page.request.get(`/api/entries/${entry.id}`)).json()).entry.size).toBe(bytes.length);
  const publicationResponse = await page.request.post(`/api/libraries/${libraryId}/publish`, { headers, data: {} });
  expect(publicationResponse.status()).toBe(201);
  const { publication } = await publicationResponse.json();
  expect((await page.request.delete(`/api/entries/${entry.id}`, { headers })).status()).toBe(200);
  expect((await page.request.get(path)).status()).toBe(404);

  expect((await page.request.post('/api/auth/logout', { headers, data: {} })).status()).toBe(204);
  await context.clearCookies();
  const emailB = `file-b-${Date.now()}@tju.edu.cn`;
  await begin(page, emailB);
  await finish(page, (await latestCode(request, emailB)).code, emailB);
  expect((await page.request.get(path)).status()).toBe(404);
  expect((await page.request.get(`/api/entries/${entry.id}`)).status()).toBe(404);
  expect((await page.request.post(`/api/market/${publication.id}/subscribe`, { headers, data: {} })).status()).toBe(200);
  const snapshot = await page.request.get(`/api/entries/${entry.id}`);
  expect(snapshot.status()).toBe(200);
  expect((await snapshot.json()).entry).toMatchObject({ kind: 'file', title: name, library_id: publication.id });
  expect(await (await page.request.get(path)).body()).toEqual(bytes);
});

test('real Agent request preserves its identity across an unavailable model and reload', async ({ page, request }) => {
  test.setTimeout(120000);
  const email = `chat-retry-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  const model = await page.request.get('/api/account/model');
  expect(model.status()).toBe(200);
  expect((await model.json()).model.source).toBe('none');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: '新手向导', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
  await expect(composer).toBeEnabled();
  const sent = [];
  page.on('request', req => {
    if (req.url().includes('/api/sessions/') && req.url().endsWith('/messages') && req.method() === 'POST') {
      sent.push(req.postDataJSON());
    }
  });
  await composer.fill('请解释主动回忆');
  const [failed] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith('/messages') && res.request().method() === 'POST'),
    page.getByRole('button', { name: '发送', exact: true }).click(),
  ]);
  expect(failed.status()).toBe(503);
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  expect(sent).toHaveLength(1);
  const requestId = sent[0].client_request_id;
  expect(requestId).toMatch(/^[0-9a-f]{32}$/);
  const sessionID = failed.url().match(/\/sessions\/([0-9a-f]{32})\/messages$/)?.[1];
  expect(sessionID).toBeTruthy();
  const pendingKey = `tjuclaw.chat.pending.v1.${(await (await page.request.get('/api/auth/session')).json()).id}.${sessionID}`;
  expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), pendingKey))
    .toMatchObject({ sessionId: sessionID, id: requestId, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect((await (await page.request.get(`/api/sessions/${sessionID}`)).json()).session.messages ?? []).toEqual([]);

  await page.reload();
  await unlockIfNeeded(page, email);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: '新手向导', exact: true }).click();
  await composer.fill('换一个问题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不能用新内容覆盖');
  expect(sent).toHaveLength(1);
  await composer.fill('请解释主动回忆');
  const [retried] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith(`/sessions/${sessionID}/messages`) && res.request().method() === 'POST'),
    page.getByRole('button', { name: '发送', exact: true }).click(),
  ]);
  expect(retried.status()).toBe(503);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

test('browser-to-API Agent reply persists across reload and deduplicates retries', async ({ page, request }) => {
  test.skip(process.env.TJUCLAW_SESSION_E2E !== '1', 'runs only with the isolated HTTPS session test endpoint');
  test.setTimeout(120000);
  const email = `chat-success-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  const model = await page.request.get('/api/account/model');
  expect(model.status()).toBe(200);
  expect((await model.json()).model).toMatchObject({ source: 'product', configured: false });
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: '新手向导', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
  await expect(composer).toBeEnabled();
  const sent = [];
  page.on('request', req => {
    if (req.url().includes('/api/sessions/') && req.url().endsWith('/messages') && req.method() === 'POST') {
      sent.push(req.postDataJSON());
    }
  });
  await composer.fill('请解释主动回忆');
  const [first] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith('/messages') && res.request().method() === 'POST'),
    page.getByRole('button', { name: '发送', exact: true }).click(),
  ]);
  expect(first.status()).toBe(200);
  const sessionID = first.url().match(/\/sessions\/([0-9a-f]{32})\/messages$/)?.[1];
  expect(sessionID).toBeTruthy();
  expect(sent[0].client_request_id).toMatch(/^[0-9a-f]{32}$/);
  await expect(page.locator('.chat-message.assistant')).toContainText('隔离测试回复：请解释主动回忆');
  const readSession = async () => (await (await page.request.get(`/api/sessions/${sessionID}`)).json()).session;
  expect((await readSession()).messages).toMatchObject([
    { role: 'user', content: '请解释主动回忆', client_request_id: sent[0].client_request_id },
    { role: 'assistant', content: '隔离测试回复：请解释主动回忆' },
  ]);
  const duplicate = await page.request.post(`/api/sessions/${sessionID}/messages`, { headers, data: sent[0] });
  expect(duplicate.status()).toBe(200);
  expect((await readSession()).messages).toHaveLength(2);

  await page.reload();
  await unlockIfNeeded(page, email);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: '新手向导', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toContainText('隔离测试回复：请解释主动回忆');
  await composer.fill('继续复习');
  const [second] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith(`/sessions/${sessionID}/messages`) && res.request().method() === 'POST'),
    page.getByRole('button', { name: '发送', exact: true }).click(),
  ]);
  expect(second.status()).toBe(200);
  await expect(page.locator('.chat-message.assistant')).toHaveCount(2);
  expect((await readSession()).messages).toHaveLength(4);

  let lostRequestId;
  await page.route(`**/api/sessions/${sessionID}/messages`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    lostRequestId = route.request().postDataJSON().client_request_id;
    const committed = await route.fetch();
    expect(committed.status(), 'the real API must commit before the response is lost').toBe(200);
    await route.abort('failed');
  });
  await composer.fill('读回已提交的回复');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(3);
  await expect(page.locator('.chat-message.assistant').last()).toContainText('隔离测试回复：读回已提交的回复');
  expect(lostRequestId).toMatch(/^[0-9a-f]{32}$/);
  expect((await readSession()).messages).toHaveLength(6);
  expect((await readSession()).messages[4]).toMatchObject({
    role: 'user', content: '读回已提交的回复', client_request_id: lostRequestId,
  });
  await page.reload();
  await unlockIfNeeded(page, email);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: '新手向导', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(3);
  await expect(composer).toHaveValue('');

  await page.unroute(`**/api/sessions/${sessionID}/messages`);
  let loseResponse = true;
  let loseReadback = true;
  await page.route(`**/api/sessions/${sessionID}/messages`, async route => {
    if (route.request().method() !== 'POST' || !loseResponse) return route.fallback();
    loseResponse = false;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.abort('failed');
  });
  await page.route(`**/api/sessions/${sessionID}`, route => {
    if (route.request().method() !== 'GET' || !loseReadback) return route.fallback();
    loseReadback = false;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"id":"library_storage_unavailable"}}' });
  });
  await composer.fill('首次读回不可用');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('发送结果未确认');
  await expect(composer).toHaveValue('首次读回不可用');
  expect((await readSession()).messages).toHaveLength(8);
  const pendingKey = `tjuclaw.chat.pending.v1.${(await (await page.request.get('/api/auth/session')).json()).id}.${sessionID}`;
  await page.evaluate(key => sessionStorage.removeItem(key), pendingKey);
  await page.getByRole('button', { name: '确认发送结果' }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(4);
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await readSession()).messages).toHaveLength(8);
  await composer.fill('确认后继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(5);
  expect((await readSession()).messages).toHaveLength(10);
  expect(sent.at(-1).client_request_id).not.toBe(sent.at(-2).client_request_id);
});

test('browser-to-edge Git workspace uses owner-scoped v2 access and preserves conflicting drafts', async ({ page, request }) => {
  test.skip(process.env.TJUCLAW_SESSION_E2E !== '1', 'requires the isolated HTTPS workspace endpoint');
  test.setTimeout(150000);
  const email = `edge-notes-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  const ownerId = (await (await page.request.get('/api/auth/session')).json()).id;
  const edgeRequests = [];
  const apiWrites = [];
  page.on('request', outgoing => {
    if (outgoing.url().startsWith('https://127.0.0.1:') && outgoing.url().includes('/v1/sessions/')) {
      edgeRequests.push({ url: outgoing.url(), method: outgoing.method(), body: outgoing.postData() });
    }
    if (outgoing.url().includes('/api/sessions/') && outgoing.method() !== 'GET') {
      apiWrites.push({ url: outgoing.url(), body: outgoing.postData() });
    }
  });
  await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
  await page.getByRole('button', { name: '打开协作笔记' }).click();
  const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
  await expect(panel).toBeVisible();
  const [listed] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/v1/sessions/notes') && response.request().method() === 'POST'),
    panel.getByRole('button', { name: '查看文件' }).click(),
  ]);
  expect(listed.status()).toBe(200);
  await expect(panel).toContainText('还没有笔记，新建第一篇吧');
  const notePath = `e2e-${Date.now()}.md`;
  await panel.getByLabel('新文件名').fill(notePath);
  const [created] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/v1/sessions/note') && response.request().method() === 'PUT'),
    panel.getByRole('button', { name: '新建 Markdown' }).click(),
  ]);
  expect(created.status()).toBe(201);
  const firstRevision = (await created.json()).revision;
  expect(firstRevision).toMatch(/^[0-9a-f]{40}$/);
  await panel.getByRole('textbox', { name: '笔记内容' }).fill('Browser created body');
  const [saved] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/v1/sessions/note') && response.request().method() === 'PATCH'),
    panel.getByRole('button', { name: '保存到 Git' }).click(),
  ]);
  expect(saved.status()).toBe(200);
  const revision = (await saved.json()).revision;
  await expect(panel.locator('pre')).toHaveText('Browser created body');
  expect(edgeRequests.some(item => item.method === 'PATCH' && item.body?.includes('Browser created body'))).toBe(true);
  expect(apiWrites.every(item => !item.body?.includes('Browser created body'))).toBe(true);
  await panel.getByLabel('检索 Git 笔记').fill('Browser created');
  const [searched] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/v1/sessions/search')),
    panel.getByRole('button', { name: '检索', exact: true }).click(),
  ]);
  expect(searched.status()).toBe(200);
  await expect(panel.locator('.sandbox-notes-results')).toContainText(notePath);
  await expect(panel.locator('.sandbox-notes-results')).toContainText('Browser created body');
  const [graphed] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/v1/sessions/graph')),
    panel.getByRole('button', { name: '查看图谱' }).click(),
  ]);
  expect(graphed.status()).toBe(200);
  await expect(panel.getByRole('group', { name: '笔记链接图，点击节点可打开笔记' })).toBeVisible();
  expect(edgeRequests.some(item => item.method === 'POST' && item.url.endsWith('/v1/sessions/search'))).toBe(true);
  expect(edgeRequests.some(item => item.method === 'POST' && item.url.endsWith('/v1/sessions/graph'))).toBe(true);
  const createRequest = JSON.parse(created.request().postData());
  expect(createRequest.owner_id).toBe(ownerId);
  const sessionId = createRequest.session_id;
  const grantResponse = await page.request.post(`/api/sessions/${sessionId}/sandbox-token`, { headers, data: {} });
  expect(grantResponse.status()).toBe(200);
  const grant = await grantResponse.json();
  expect(grant.token).toMatch(/^v2\./);
  expect(grant.gateway_url).toMatch(/^https:\/\/127\.0\.0\.1:/);
  const edge = new URL('/v1/sessions/note', grant.gateway_url).toString();
  const external = await page.request.patch(edge, {
    headers: { ...headers, Authorization: `Bearer ${grant.token}` },
    data: { ...createRequest, expected_revision: revision, content: 'Remote concurrent edit' },
  });
  expect(external.status()).toBe(200);
  const unauthorizedSession = await page.request.post(`/api/sessions/${'0'.repeat(32)}/sandbox-token`, { headers, data: {} });
  expect(unauthorizedSession.status()).toBe(404);
  const wrongOwner = await page.request.post(edge, {
    headers: { ...headers, Authorization: `Bearer ${grant.token}` },
    data: { ...createRequest, owner_id: 'other-owner' },
  });
  expect(wrongOwner.status()).toBe(401);
  const wrongOrigin = await page.request.post(edge, {
    headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${grant.token}` },
    data: createRequest,
  });
  expect(wrongOrigin.status()).toBe(403);
  expect(wrongOrigin.headers()['access-control-allow-origin']).toBeUndefined();
  const modelRoute = await page.request.post(new URL('/v1/sessions/message', grant.gateway_url).toString(), {
    headers: { ...headers, Authorization: `Bearer ${grant.token}` },
    data: { ...createRequest, turn: 1, content: 'try executing model' },
  });
  expect(modelRoute.status()).toBe(401);
  await panel.getByRole('button', { name: '编辑文件' }).click();
  await panel.getByRole('textbox', { name: '笔记内容' }).fill('Do not overwrite remote');
  const [conflict] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/v1/sessions/note') && response.request().method() === 'PATCH'),
    panel.getByRole('button', { name: '保存到 Git' }).click(),
  ]);
  expect(conflict.status()).toBe(409);
  await expect(panel.getByRole('alert')).toContainText('远端文件已更新');
  await expect(panel.getByRole('textbox', { name: '笔记内容' })).toHaveValue('Do not overwrite remote');
  expect((await (await page.request.post(edge, {
    headers: { ...headers, Authorization: `Bearer ${grant.token}` }, data: createRequest,
  })).json()).content).toBe('Remote concurrent edit');
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await unlockIfNeeded(page, email);
  await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
  await page.getByRole('button', { name: '打开协作笔记' }).click();
  const reopened = page.getByRole('region', { name: 'Agent Git 工作区' });
  await reopened.getByRole('button', { name: '查看文件' }).click();
  await reopened.getByRole('button', { name: notePath }).click();
  await expect(reopened.locator('pre')).toHaveText('Remote concurrent edit');
});

test('browser-to-API vault verifier and private notes survive a fresh browser and reject replay', async ({ page, browser, request }) => {
  test.skip(process.env.TJUCLAW_SESSION_E2E !== '1', 'runs only with the isolated HTTPS vault test endpoint');
  test.setTimeout(150000);
  const email = `vault-${Date.now()}@tju.edu.cn`;
  expect((await request.get('/api/vault/status')).status()).toBe(401);
  await begin(page, email);
  const vaultResponses = [];
  page.on('response', response => {
    if (response.url().includes('/api/vault/objects/')) vaultResponses.push(`${response.request().method()} ${response.status()}`);
  });
  try {
    await finish(page, (await latestCode(request, email)).code, email);
  } catch (error) {
    throw new Error(`Vault setup failed (${vaultResponses.join(', ')}): ${error.message}`);
  }
  expect(await (await page.request.get('/api/vault/status')).json()).toEqual({ configured: true });
  const passphrase = workspacePassphrases.get(email);
  expect(passphrase).toBeTruthy();
  const { libraries } = await (await page.request.get('/api/libraries')).json();
  const libraryId = libraries.find(item => item.role === 'owner')?.id;
  expect(libraryId).toMatch(/^[0-9a-f]{32}$/);
  const id = createHash('sha256').update(`tjuclaw:workspace-verifier:v1:${libraryId}`).digest('hex').slice(0, 32);
  const response = await page.request.get(`/api/vault/objects/${id}`);
  expect(response.status()).toBe(200);
  const revision = response.headers().etag;
  const sealed = await response.json();
  expect(sealed).toMatchObject({ version: 1, salt: expect.any(String), nonce: expect.any(String), ciphertext: expect.any(String) });
  expect(JSON.stringify(sealed)).not.toContain(passphrase);
  expect(JSON.stringify(sealed)).not.toContain(`tjuclaw:workspace-verifier:v1:${libraryId}`);
  const replay = await page.request.put(`/api/vault/objects/${id}`, {
    headers: { ...headers, 'Content-Type': 'application/vnd.tjuclaw.sealed+json', 'If-None-Match': '*' }, data: sealed,
  });
  expect(replay.status()).toBe(409);
  const rejectedOrigin = await page.request.put(`/api/vault/objects/${id}`, {
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/vnd.tjuclaw.sealed+json', 'If-Match': revision }, data: sealed,
  });
  expect(rejectedOrigin.status()).toBe(403);
  expect((await page.request.get(`/api/vault/objects/${id}`)).headers().etag).toBe(revision);

  const privateTitle = `Private title ${Date.now()}`;
  const privateBody = 'Only the browser should decrypt this note.';
  const privateWrites = [];
  page.on('request', outgoing => {
    if (outgoing.method() === 'PUT' && outgoing.url().includes('/api/vault/objects/')) {
      privateWrites.push(outgoing.postData() ?? '');
    }
  });
  await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
  await page.getByRole('button', { name: /^私密笔记/ }).click();
  const privatePanel = page.getByRole('region', { name: '私密笔记' });
  await privatePanel.getByLabel('再次输入工作区口令以解密私密笔记').fill(passphrase);
  await privatePanel.getByRole('button', { name: '解锁私密笔记' }).click();
  await expect(privatePanel).toContainText('0 篇加密笔记');
  await privatePanel.getByLabel('新笔记标题').fill(privateTitle);
  await privatePanel.getByRole('button', { name: '新建私密笔记' }).click();
  await privatePanel.getByRole('textbox', { name: '私密笔记正文' }).fill(privateBody);
  await privatePanel.getByRole('button', { name: '保存密文' }).click();
  await expect(privatePanel.locator('pre')).toHaveText(privateBody);
  expect(privateWrites).toHaveLength(3);
  for (const payload of privateWrites) {
    expect(payload).not.toContain(passphrase);
    expect(payload).not.toContain(privateTitle);
    expect(payload).not.toContain(privateBody);
  }
  const notebookID = createHash('sha256').update(`tjuclaw:private-notebook:v1:${libraryId}`).digest('hex').slice(0, 32);
  const notebookResponse = await page.request.get(`/api/vault/objects/${notebookID}`);
  expect(notebookResponse.status()).toBe(200);
  const sealedNotebook = JSON.stringify(await notebookResponse.json());
  expect(sealedNotebook).not.toContain(privateTitle);
  expect(sealedNotebook).not.toContain(privateBody);

  const context = await browser.newContext({ baseURL: origin });
  try {
    await context.addCookies((await page.context().storageState()).cookies);
    const fresh = await context.newPage();
    await fresh.goto('/workspace');
    await expect(fresh.getByRole('heading', { name: '解锁工作区', exact: true })).toBeVisible();
    expect(await fresh.evaluate(() => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter(key => key?.startsWith('tjuclaw.workspace.vault.v1.')))).toEqual([]);
    await fresh.getByLabel('工作区口令', { exact: true }).fill('incorrect-passphrase');
    await fresh.getByRole('button', { name: '解锁进入工作区', exact: true }).click();
    await expect(fresh.getByRole('alert')).toContainText('口令不正确');
    await fresh.getByLabel('工作区口令', { exact: true }).fill(passphrase);
    await fresh.getByRole('button', { name: '解锁进入工作区', exact: true }).click();
    await expect(fresh.locator('.sidebar-library-button')).toBeVisible();
    await fresh.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await fresh.getByRole('button', { name: /^私密笔记/ }).click();
    const freshPanel = fresh.getByRole('region', { name: '私密笔记' });
    await freshPanel.getByLabel('再次输入工作区口令以解密私密笔记').fill(passphrase);
    await freshPanel.getByRole('button', { name: '解锁私密笔记' }).click();
    await freshPanel.getByRole('button', { name: privateTitle }).click();
    await expect(freshPanel.locator('pre')).toHaveText(privateBody);
    const renamedTitle = `${privateTitle} renamed`;
    await freshPanel.getByRole('button', { name: '修改标题' }).click();
    await freshPanel.getByLabel('修改私密笔记标题').fill(renamedTitle);
    await freshPanel.getByRole('button', { name: '保存标题' }).click();
    await expect(freshPanel.getByRole('button', { name: renamedTitle })).toBeVisible();
    const renamedObject = JSON.stringify(await (await fresh.request.get(`/api/vault/objects/${notebookID}`)).json());
    expect(renamedObject).not.toContain(renamedTitle);
    await privatePanel.getByRole('button', { name: '修改标题' }).click();
    await privatePanel.getByLabel('修改私密笔记标题').fill('stale browser overwrite');
    await privatePanel.getByRole('button', { name: '保存标题' }).click();
    await expect(privatePanel.getByRole('alert')).toContainText('远端版本已更新');
    await expect(privatePanel.getByRole('button', { name: privateTitle })).toBeVisible();
    await privatePanel.getByRole('button', { name: '取消改名' }).click();
    page.once('dialog', dialog => dialog.accept());
    await privatePanel.getByRole('button', { name: '删除私密笔记' }).click();
    await expect(privatePanel.getByRole('alert')).toContainText('远端版本已更新');
    await expect(freshPanel.getByRole('button', { name: renamedTitle })).toBeVisible();
    let pendingNoteID = '';
    const interruptedDelete = async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      pendingNoteID = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"id":"vault_unavailable"}}' });
    };
    await fresh.route('**/api/vault/objects/*', interruptedDelete);
    fresh.once('dialog', dialog => dialog.accept());
    await freshPanel.getByRole('button', { name: '删除私密笔记' }).click();
    await expect(freshPanel.getByRole('status')).toContainText('密文清理尚未完成');
    expect(pendingNoteID).toMatch(/^[0-9a-f]{32}$/);
    expect((await fresh.request.get(`/api/vault/objects/${pendingNoteID}`)).status()).toBe(200);
    const pendingIndex = JSON.stringify(await (await fresh.request.get(`/api/vault/objects/${notebookID}`)).json());
    expect(pendingIndex).not.toContain(renamedTitle);
    await fresh.unroute('**/api/vault/objects/*', interruptedDelete);
    await fresh.reload();
    await fresh.getByLabel('工作区口令', { exact: true }).fill(passphrase);
    await fresh.getByRole('button', { name: '解锁进入工作区', exact: true }).click();
    await fresh.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await fresh.getByRole('button', { name: /^私密笔记/ }).click();
    const retried = fresh.getByRole('region', { name: '私密笔记' });
    await retried.getByLabel('再次输入工作区口令以解密私密笔记').fill(passphrase);
    await retried.getByRole('button', { name: '解锁私密笔记' }).click();
    await expect(retried).toContainText('0 篇加密笔记');
    await expect(retried.getByText('密文清理尚未完成')).toHaveCount(0);
    expect((await fresh.request.get(`/api/vault/objects/${pendingNoteID}`)).status()).toBe(404);
  } finally {
    await context.close();
  }
  const legacyTitle = `Legacy copy ${Date.now()}`;
  const legacyBody = '# Original Markdown remains in PostgreSQL';
  const createdLegacy = await page.request.post(`/api/libraries/${libraryId}/entries`, {
    headers, data: { kind: 'note', title: legacyTitle, body: legacyBody },
  });
  expect(createdLegacy.status()).toBe(201);
  const legacyId = (await createdLegacy.json()).entry.id;
  await privatePanel.getByRole('button', { name: '刷新', exact: true }).click();
  await privatePanel.getByRole('button', { name: '查看可复制的旧 Markdown' }).click();
  await privatePanel.getByLabel('选择一篇旧资料库笔记').selectOption(legacyId);
  page.once('dialog', dialog => {
    expect(dialog.message()).toContain('原件仍以明文留在旧资料库');
    return dialog.accept();
  });
  await privatePanel.getByRole('button', { name: '复制并核对密文' }).click();
  await expect(privatePanel.getByRole('status')).toContainText('密文已回读核对');
  await expect(privatePanel.locator('pre')).toHaveText(legacyBody);
  expect((await (await page.request.get(`/api/entries/${legacyId}`)).json()).entry.body).toBe(legacyBody);
  for (const payload of privateWrites) {
    expect(payload).not.toContain(legacyTitle);
    expect(payload).not.toContain(legacyBody);
    expect(payload).not.toContain(legacyId);
  }
  const copiedIndex = JSON.stringify(await (await page.request.get(`/api/vault/objects/${notebookID}`)).json());
  expect(copiedIndex).not.toContain(legacyTitle);
  expect(copiedIndex).not.toContain(legacyId);
  await page.reload();
  await unlockIfNeeded(page, email);
  await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
  await page.getByRole('button', { name: /^私密笔记/ }).click();
  const importedPanel = page.getByRole('region', { name: '私密笔记' });
  await importedPanel.getByLabel('再次输入工作区口令以解密私密笔记').fill(passphrase);
  await importedPanel.getByRole('button', { name: '解锁私密笔记' }).click();
  await importedPanel.getByRole('button', { name: legacyTitle }).click();
  await expect(importedPanel.locator('pre')).toHaveText(legacyBody);
  const missingRevision = await page.request.delete(`/api/vault/objects/${id}`, { headers });
  expect(missingRevision.status()).toBe(428);
  const staleRevision = await page.request.delete(`/api/vault/objects/${id}`, {
    headers: { ...headers, 'If-Match': '"0000000000000000000000000000000000000000"' },
  });
  expect(staleRevision.status()).toBe(409);
  const rejectedDelete = await page.request.delete(`/api/vault/objects/${id}`, {
    headers: { Origin: 'https://attacker.example', 'If-Match': revision },
  });
  expect(rejectedDelete.status()).toBe(403);
  expect((await page.request.get(`/api/vault/objects/${id}`)).status()).toBe(200);
  const deleted = await page.request.delete(`/api/vault/objects/${id}`, {
    headers: { ...headers, 'If-Match': revision },
  });
  expect(deleted.status()).toBe(204);
  expect((await page.request.get(`/api/vault/objects/${id}`)).status()).toBe(404);
});

test('real identity service rejects new non-campus registration before sending mail', async ({ page, request }) => {
  const email = `outside-${Date.now()}@example.com`;
  await page.goto('/auth/registration');
  await page.getByLabel('邮箱地址', { exact: true }).fill(email);
  await solveCap(page);
  const [response] = await Promise.all([
    page.waitForResponse(res => res.url().endsWith('/api/auth/start')),
    page.getByRole('button', { name: '获取验证码', exact: true }).click(),
  ]);
  expect(response.status()).toBe(403);
  await expect(page.getByRole('alert')).toContainText('@tju.edu.cn');
  const { messages } = await (await request.get('http://127.0.0.1:18026/api/v1/messages')).json();
  expect(messages.some(message => message.To.some(to => to.Address === email))).toBe(false);
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
  const email = `e2e-${Date.now()}@tju.edu.cn`;
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
  const emailA = `lib-a-${Date.now()}@tju.edu.cn`;
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
  await expect(page.getByLabel('正文', { exact: true })).toHaveText(body);
  const { entry: current } = await (await page.request.get(`/api/entries/${note.id}`)).json();
  const remoteBody = 'Edited on another device';
  const remoteSave = await page.request.patch(`/api/entries/${note.id}`, {
    headers, data: { body: remoteBody, expected_updated_at: current.updated_at },
  });
  expect(remoteSave.status()).toBe(200);
  const draftBody = 'Unsaved local changes';
  await page.getByLabel('正文', { exact: true }).fill(draftBody);
  await expect(page.locator('.workspace-save-conflict')).toBeVisible();
  await expect(page.getByLabel('正文', { exact: true })).toHaveText(draftBody);
  expect((await (await page.request.get(`/api/entries/${note.id}`)).json()).entry.body).toBe(remoteBody);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '加载云端版本' }).click();
  await expect(page.locator('.workspace-save-conflict')).toHaveCount(0);
  await expect(page.getByLabel('正文', { exact: true })).toHaveText(remoteBody);
  const resumedBody = 'Continued after resolving conflict';
  await page.getByLabel('正文', { exact: true }).fill(resumedBody);
  await expect.poll(async () => (await (await page.request.get(`/api/entries/${note.id}`)).json()).entry.body).toBe(resumedBody);
  expect((await page.request.post('/api/auth/logout', { headers, data: {} })).status()).toBe(204);
  await context.clearCookies();
  const emailB = `lib-b-${Date.now()}@tju.edu.cn`;
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

test('real note save reconciles a committed PATCH whose browser response was lost', async ({ page, request }) => {
  test.setTimeout(180000);
  const email = `save-recovery-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);

  const librariesResponse = await page.request.get('/api/libraries');
  expect(librariesResponse.status()).toBe(200);
  const { libraries } = await librariesResponse.json();
  const created = await page.request.post(`/api/libraries/${libraries[0].id}/entries`, {
    headers, data: { kind: 'note', title: 'Recovery integration note', body: 'Initial content' },
  });
  expect(created.status()).toBe(201);
  const { entry } = await created.json();
  await page.reload();
  await page.getByRole('treeitem', { name: entry.title }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveText('Initial content');

  let patchCount = 0;
  const patchBodies = [];
  await page.route(`**/api/entries/${entry.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patchCount++;
    patchBodies.push(route.request().postDataJSON().body);
    if (patchCount !== 1) return route.fallback();
    const committed = await route.fetch();
    expect(committed.status(), 'the real API must commit the first PATCH').toBe(200);
    await route.abort('failed');
  });
  const draft = 'Saved despite a lost response';
  await page.getByLabel('正文', { exact: true }).fill(draft);
  await expect.poll(() => patchBodies.length).toBeGreaterThan(0);
  expect(patchBodies[0]).toBe(draft);
  await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible();
  expect((await (await page.request.get(`/api/entries/${entry.id}`)).json()).entry.body).toBe(draft);
  await page.getByRole('button', { name: '重试保存' }).click();
  await expect.poll(() => patchCount).toBe(2);
  await expect(page.getByRole('button', { name: '重试保存' })).toHaveCount(0);
  await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
  const { entry: confirmed } = await (await page.request.get(`/api/entries/${entry.id}`)).json();
  await page.waitForTimeout(800); // Longer than the editor's 650 ms autosave debounce.
  expect(patchBodies).toEqual([draft, draft]);
  expect((await (await page.request.get(`/api/entries/${entry.id}`)).json()).entry.updated_at).toBe(confirmed.updated_at);
  await page.reload();
  await page.getByRole('treeitem', { name: entry.title }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveText(draft);
});

test('real note move follows autosave and rejects a stale cross-device revision', async ({ page, request }) => {
  test.setTimeout(180000);
  const email = `move-revision-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  const { libraries } = await (await page.request.get('/api/libraries')).json();
  const libraryId = libraries.find(item => item.role === 'owner')?.id;
  expect(libraryId).toBeTruthy();
  const created = await page.request.post(`/api/libraries/${libraryId}/entries`, {
    headers, data: { kind: 'note', title: 'Move revision integration note', body: 'Initial content' },
  });
  expect(created.status()).toBe(201);
  const { entry: original } = await created.json();
  const folderResponse = await page.request.post(`/api/libraries/${libraryId}/folders`, {
    headers, data: { title: 'Move revision folder' },
  });
  expect(folderResponse.status()).toBe(201);
  const { folder } = await folderResponse.json();
  await page.reload();
  await page.getByRole('treeitem', { name: original.title }).click();
  const editor = page.getByLabel('正文', { exact: true });
  await expect(editor).toHaveText('Initial content');
  await editor.fill('Saved before moving');
  await page.getByRole('treeitem', { name: original.title }).getByRole('button', { name: '文档操作' }).click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  const [move] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/entries/${original.id}/move`) && response.request().method() === 'POST'),
    page.getByRole('dialog', { name: '移动到' }).getByRole('button', { name: folder.title }).click(),
  ]);
  expect(move.status()).toBe(200);
  const moved = (await (await page.request.get(`/api/entries/${original.id}`)).json()).entry;
  expect(moved).toMatchObject({ parent_id: folder.id, body: 'Saved before moving' });
  expect(move.request().postDataJSON().expected_updated_at).not.toBe(original.updated_at);
  const stale = await page.request.post(`/api/entries/${original.id}/move`, {
    headers, data: { parent_id: '', expected_updated_at: original.updated_at },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.id).toBe('entry_conflict');
  expect((await (await page.request.get(`/api/entries/${original.id}`)).json()).entry.parent_id).toBe(folder.id);
  await editor.fill('Saved after moving');
  await expect.poll(async () => (await (await page.request.get(`/api/entries/${original.id}`)).json()).entry.body)
    .toBe('Saved after moving');
  await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
  await page.reload();
  await page.getByRole('treeitem', { name: original.title }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveText('Saved after moving');
  expect((await (await page.request.get(`/api/entries/${original.id}`)).json()).entry.parent_id).toBe(folder.id);
});

test('real folder deletion cascades through PostgreSQL and clears the active note', async ({ page, request }) => {
  test.setTimeout(180000);
  const email = `folder-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  const { libraries } = await (await page.request.get('/api/libraries')).json();
  const libraryId = libraries[0].id;
  async function create(path, data, field) {
    const response = await page.request.post(path, { headers, data });
    expect(response.status()).toBe(201);
    return (await response.json())[field];
  }
  const parent = await create(`/api/libraries/${libraryId}/folders`, { title: '待删除的资料' }, 'folder');
  const child = await create(`/api/libraries/${libraryId}/folders`, { title: '嵌套资料', parent_id: parent.id }, 'folder');
  const nested = await create(`/api/libraries/${libraryId}/entries`, { kind: 'note', title: '嵌套笔记', body: '不可留在侧栏', parent_id: child.id }, 'entry');
  const survivor = await create(`/api/libraries/${libraryId}/entries`, { kind: 'note', title: '根目录保留笔记', body: '仍然存在' }, 'entry');
  const movable = await create(`/api/libraries/${libraryId}/entries`, { kind: 'note', title: '待移动的笔记', body: '稍后随文件夹删除' }, 'entry');
  await page.reload();
  await page.getByRole('treeitem', { name: movable.title }).getByRole('button', { name: '文档操作' }).click();
  const [reordered] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/libraries/${libraryId}/entries/order`) && response.request().method() === 'PUT'),
    page.getByRole('menuitem', { name: '上移' }).click(),
  ]);
  expect(reordered.status()).toBe(200);
  const ordered = (await (await page.request.get(`/api/libraries/${libraryId}/entries`)).json()).entries;
  expect(ordered.find(entry => entry.id === movable.id).sort_order).toBeLessThan(ordered.find(entry => entry.id === survivor.id).sort_order);
  await page.reload();
  const rootNotes = page.locator('.obsidian-tree > .obsidian-tree-node > .obsidian-tree-row[role="treeitem"]');
  await expect(rootNotes).toContainText([movable.title, survivor.title]);
  await page.getByRole('treeitem', { name: movable.title }).getByRole('button', { name: '文档操作' }).click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  const [moved] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/entries/${movable.id}/move`) && response.request().method() === 'POST'),
    page.getByRole('dialog').getByRole('button', { name: child.title }).click(),
  ]);
  expect(moved.status()).toBe(200);
  expect((await (await page.request.get(`/api/entries/${movable.id}`)).json()).entry.parent_id).toBe(child.id);
  await page.reload();
  await expect(page.getByRole('treeitem', { name: movable.title })).toBeVisible();
  await page.getByRole('treeitem', { name: nested.title }).click();
  await expect(page.getByLabel('正文', { exact: true })).toHaveText('不可留在侧栏');
  await page.locator('.obsidian-tree-row')
    .filter({ has: page.getByRole('button', { name: parent.title, exact: true }) })
    .getByRole('button', { name: '文件夹操作' }).click();
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('永久删除');
    await dialog.accept();
  });
  const [deletion] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/folders/${parent.id}`) && response.request().method() === 'DELETE'),
    page.getByRole('menuitem', { name: '删除' }).click(),
  ]);
  expect(deletion.status()).toBe(200);
  expect((await deletion.json()).strategy).toBe('cascade');
  await expect(page.getByRole('treeitem', { name: nested.title })).toHaveCount(0);
  await expect(page.getByLabel('正文', { exact: true })).toHaveCount(0);
  for (const id of [parent.id, child.id, nested.id, movable.id]) {
    expect((await page.request.get(`/api/entries/${id}`)).status()).toBe(404);
  }
  expect((await page.request.get(`/api/entries/${survivor.id}`)).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('treeitem', { name: survivor.title })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: nested.title })).toHaveCount(0);
});

test('real flashcard API persists reviews, reconciles requests and isolates accounts', async ({ page, request, context }) => {
  test.setTimeout(180000);
  const emailA = `anki-a-${Date.now()}@tju.edu.cn`;
  await begin(page, emailA);
  await finish(page, (await latestCode(request, emailA)).code, emailA);
  await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
  await expect(page.locator('.anki-workspace')).toBeVisible();
  const decksResponse = await page.request.get('/api/decks');
  expect(decksResponse.status()).toBe(200);
  const { decks } = await decksResponse.json();
  expect(decks).toHaveLength(1);
  await page.getByRole('button', { name: '新建卡片' }).click();
  await page.getByRole('textbox', { name: '正面' }).fill('真实题目');
  await page.getByRole('textbox', { name: '背面' }).fill('真实答案');
  let card;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/cards?deck_id=${decks[0].id}`);
    if (response.status() !== 200) return false;
    card = (await response.json()).cards.find(item => item.front === '真实题目' && item.back === '真实答案');
    return Boolean(card);
  }).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
  await expect(page.locator('.anki-browser-front strong')).toContainText('真实题目');
  await page.locator('.anki-sidebar-deck').click();
  await page.locator('.anki-review-card').click();
  const [first] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/reviews') && response.request().method() === 'POST'),
    page.getByRole('button', { name: /良好/ }).click(),
  ]);
  expect(first.status()).toBe(200);
  const firstResult = await first.json();
  expect(firstResult.card.reps).toBe(1);
  const requestId = firstResult.review.client_request_id;
  expect(requestId).toMatch(/^[0-9a-f]{32}$/);
  const lookup = `/api/reviews/requests/${requestId}`;
  const retry = await page.request.post('/api/reviews', {
    headers, data: { card_id: card.id, rating: 3, client_request_id: requestId },
  });
  expect(retry.status()).toBe(200);
  const retried = await retry.json();
  expect(retried.review.id).toBe(firstResult.review.id);
  expect(retried.card.reps).toBe(1);
  const found = await page.request.get(lookup);
  expect(found.status()).toBe(200);
  expect((await found.json()).review.id).toBe(firstResult.review.id);
  await page.reload();
  await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
  await expect(page.locator('.anki-browser-front strong')).toContainText('真实题目');
  const cardsResponse = await page.request.get(`/api/cards?deck_id=${decks[0].id}`);
  expect(cardsResponse.status()).toBe(200);
  expect((await cardsResponse.json()).cards.find(item => item.id === card.id)?.reps).toBe(1);

  expect((await page.request.post('/api/auth/logout', { headers, data: {} })).status()).toBe(204);
  await context.clearCookies();
  const emailB = `anki-b-${Date.now()}@tju.edu.cn`;
  await begin(page, emailB);
  await finish(page, (await latestCode(request, emailB)).code, emailB);
  expect((await page.request.get(lookup)).status()).toBe(404);
  expect((await page.request.get(`/api/cards/${card.id}`)).status()).toBe(404);
  const ownDecks = await page.request.get('/api/decks');
  expect(ownDecks.status()).toBe(200);
  expect((await ownDecks.json()).decks.map(item => item.id)).not.toContain(decks[0].id);
  await page.evaluate(() => localStorage.setItem('tjuclaw.anki.cards.v1', JSON.stringify([
    { id: 'legacy-other-account', front: '旧账号私有题目', back: '不要显示', tags: '' },
  ])));
  await page.route('**/api/decks', route => route.fulfill({
    status: 503, contentType: 'application/json', body: '{"error":{"id":"anki_storage_unavailable"}}',
  }));
  await page.reload();
  await unlockIfNeeded(page, emailB);
  await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试连接' })).toBeVisible();
  await expect(page.getByText('旧账号私有题目')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载旧版浏览器备份' }).click();
  const backup = await download;
  expect(backup.suggestedFilename()).toBe('tjuclaw-legacy-browser-cards.json');
  expect(await readFile(await backup.path(), 'utf8')).toContain('旧账号私有题目');
  expect(await page.evaluate(() => localStorage.getItem('tjuclaw.anki.cards.v1'))).toContain('旧账号私有题目');
});

test('real Anki TSV import and export round-trip through the browser and PostgreSQL', async ({ page, request }) => {
  test.setTimeout(120000);
  const email = `anki-tsv-${Date.now()}@tju.edu.cn`;
  await begin(page, email);
  await finish(page, (await latestCode(request, email)).code, email);
  await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
  const tsv = '周期复习\t将回忆分散到多天\t心理学 重点\n';
  const [imported] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/decks/import') && response.request().method() === 'POST'),
    page.locator('.anki-workspace input[type=file]').setInputFiles({
      name: '考前复习.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from(tsv),
    }),
  ]);
  expect(imported.status()).toBe(201);
  const { deck, cards } = await imported.json();
  expect(deck.name).toBe('考前复习');
  expect(cards).toMatchObject([{ deck_id: deck.id, front: '周期复习', back: '将回忆分散到多天', tags: ['心理学', '重点'] }]);
  await expect(page.locator('.anki-browser-front strong')).toHaveText('周期复习');
  const [exported, download] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith(`/api/decks/${deck.id}/export`)),
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 Anki' }).click(),
  ]);
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toContain('text/tab-separated-values');
  expect(await readFile(await download.path(), 'utf8')).toBe(tsv);
  const [second] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/decks/import') && response.request().method() === 'POST'),
    page.locator('.anki-workspace input[type=file]').setInputFiles({
      name: '复核.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from(tsv),
    }),
  ]);
  expect(second.status()).toBe(201);
  const { deck: copy } = await second.json();
  expect(copy.id).not.toBe(deck.id);
  const forbidden = await page.request.post('/api/decks/import', {
    headers: { Origin: 'https://attacker.example' }, data: { name: '不应写入', tsv },
  });
  expect(forbidden.status()).toBe(403);
  await page.reload();
  await unlockIfNeeded(page, email);
  await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
  await page.locator('.anki-sidebar-deck').filter({ hasText: copy.name }).click();
  await expect(page.locator('.anki-review-card')).toContainText('周期复习');
  const decks = (await (await page.request.get('/api/decks')).json()).decks;
  expect(decks.map(item => item.name)).toEqual(expect.arrayContaining(['默认牌组', deck.name, copy.name]));
  expect(decks).toHaveLength(3);
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
  await begin(page, `expired-${Date.now()}@tju.edu.cn`, '/auth/verification');
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
