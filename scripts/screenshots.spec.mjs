import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Demo screenshots for Docs and the competition deck. The API is mocked with
// realistic study content so every run renders the same pixels; nothing here
// proves live deployment, retrieval or Agent execution.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'screenshots');
const ORIGIN = 'https://app.tjuclaw.cloud';
const PREVIEW = 'http://127.0.0.1:1425';
fs.mkdirSync(outDir, { recursive: true });

// 1280×720 at 2×: 16:9, sharp, and the interface keeps a natural size when scaled down.
const DESKTOP = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 };
const MOBILE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

const identity = { id: 'demo-identity-tju-2026', email: 'student@tju.edu.cn', email_verified: true, expires_at: '2099-01-01T00:00:00Z' };
const hex = n => n.toString(16).padStart(32, '0');
const at = minutes => new Date(Date.UTC(2026, 8, 28, 1, 0) + minutes * 60000).toISOString();

const library = { id: hex(0xa1), name: '天大学习知识库', created_at: at(0), updated_at: at(600) };
const ids = {
  circuits: hex(0xf1), calculus: hex(0xf2), campus: hex(0xf3),
  kcl: hex(0xb1), nodal: hex(0xb2), thevenin: hex(0xb3), plan: hex(0xb4), taylor: hex(0xb5), rooms: hex(0xb6), lab: hex(0xb7),
  guide: hex(0xc1), tutor: hex(0xc2), session: hex(0xd1),
};

const bodies = {
  kcl: `> 电路分析的两条基本约束：**节点电流守恒** 与 **回路电压守恒**。与 [[节点电压法]]、[[戴维南等效]] 配合使用。

## 基尔霍夫电流定律（KCL）

任一节点，流入电流之和等于流出电流之和：

**Σ iₖ = 0**

- 参考方向可任意假设，结果为负说明实际方向相反
- 适用于**广义节点**（任意闭合面）

## 基尔霍夫电压定律（KVL）

沿任一闭合回路，各段电压代数和为零：**Σ uₖ = 0**。

| 定律 | 约束对象 | 独立方程数 |
| --- | --- | --- |
| KCL | 节点 | n − 1 |
| KVL | 回路 | b − n + 1 |

## 易错点

1. 受控源也要列入 KCL / KVL
2. 电压源两端电压已知，但电流未知
3. 电流源所在支路不能列 KVL 求电流

- [x] 整理课本例 1-6
- [ ] 完成习题 1.12 ~ 1.18
- [ ] 周四前与 [[期末复习计划]] 对齐进度
`,
  nodal: `以节点电压为未知量，对 n − 1 个独立节点列 [[基尔霍夫定律]] 中的 KCL 方程。

## 步骤

1. 选参考节点（通常取连接支路最多的节点）
2. 自导 × 本节点电压 − Σ 互导 × 相邻节点电压 = 流入电流源代数和
3. 含受控源时补充控制量方程

> 电压源支路处理：引入**超节点**，或把电压源一端设为参考节点。
`,
  thevenin: `任一线性含源二端网络，对外可等效为电压源 **U_oc** 串联电阻 **R_eq**。

- **U_oc**：端口开路电压
- **R_eq**：独立源置零后的端口等效电阻，含受控源时用**外加电源法**

与 [[节点电压法]] 结合求开路电压最快。
`,
  plan: `## 本周（第 5 教学周）

| 科目 | 章节 | 状态 |
| --- | --- | --- |
| 电路分析 | [[基尔霍夫定律]]、[[节点电压法]] | 进行中 |
| 高等数学 | [[泰勒公式]] | 已完成 |
| 大学物理 | 刚体转动 | 未开始 |

- [x] 周一：电路第 1 章习题
- [x] 周二：高数泰勒展开例题
- [ ] 周三：电路实验预习（[[电路实验报告模板]]）
- [ ] 周四 19:00：北洋园 45 楼自习

> 让 Agent 每晚根据课表生成第二天的复习安排。
`,
  taylor: `\`f(x) = Σ f⁽ᵏ⁾(x₀)/k! · (x − x₀)ᵏ + Rₙ(x)\`，余项可取皮亚诺型或拉格朗日型。

## 常用展开（x → 0）

- \`eˣ = 1 + x + x²/2! + o(x²)\`
- \`sin x = x − x³/3! + o(x³)\`
- \`ln(1 + x) = x − x²/2 + o(x²)\`
`,
  rooms: `- 北洋园 45 楼、46 楼晚间空闲教室较多
- 卫津路 23 教适合周末
- 期中周图书馆 **提前 30 分钟** 到

参见 [[期末复习计划]]。
`,
  lab: `## 实验目的
验证 [[基尔霍夫定律]]。

## 数据记录

| 支路 | I (mA) | U (V) |
| --- | --- | --- |
| R1 | 12.4 | 3.10 |
| R2 | 7.9 | 1.98 |
| R3 | 4.5 | 1.12 |
`,
};

function note(key, title, parent, minutes) {
  return { id: ids[key], library_id: library.id, parent_id: parent, kind: 'note', title, body: bodies[key], created_at: at(minutes), updated_at: at(minutes + 30) };
}
function folder(key, title, minutes) {
  return { id: ids[key], library_id: library.id, parent_id: '', kind: 'folder', title, created_at: at(minutes), updated_at: at(minutes) };
}

const entries = [
  folder('circuits', '电路分析', 1), folder('calculus', '高等数学', 2), folder('campus', '校园生活', 3),
  note('kcl', '基尔霍夫定律', ids.circuits, 10), note('nodal', '节点电压法', ids.circuits, 20),
  note('thevenin', '戴维南等效', ids.circuits, 30), note('lab', '电路实验报告模板', ids.circuits, 40),
  note('taylor', '泰勒公式', ids.calculus, 50), note('rooms', '自习室与课表', ids.campus, 60),
  note('plan', '期末复习计划', '', 70),
  { id: ids.guide, library_id: library.id, parent_id: '', kind: 'agent', preset: 'guide', title: '新手向导', created_at: at(0), updated_at: at(0) },
  { id: ids.tutor, library_id: library.id, parent_id: '', kind: 'agent', title: '电路课助教', created_at: at(5), updated_at: at(5) },
].map((entry, index) => ({ ...entry, sort_order: index + 1 }));

const readOutput = (key, title) => JSON.stringify({ ok: true, data: { name: 'read_entry', result: { id: ids[key], title, body: bodies[key].slice(0, 160) } } });

const cloudTurn = [
  { role: 'user', content: '帮我梳理一下基尔霍夫定律，并出 3 道自测题。', client_request_id: hex(0xe1), created_at: at(600) },
  {
    role: 'assistant', created_at: at(601), tools: ['list_tree', 'read_entry', 'search_course_materials', 'bash'],
    content: `根据你的笔记《基尔霍夫定律》和课程资料，整理如下：

**核心结论**
- **KCL**：任一节点 Σ i = 0，可推广到任意闭合面
- **KVL**：任一回路 Σ u = 0，受控源同样计入
- 独立方程数：KCL 取 n − 1 个，KVL 取 b − n + 1 个

**自测题**
1. 某节点流入 3 A、2 A，流出 1 A 和 iₓ，求 iₓ。（答案：4 A）
2. 含 4 个节点、6 条支路的电路，独立 KVL 方程有几个？（答案：3）
3. 为什么电流源支路不能直接列 KVL 求电流？

我已在沙箱里用 Python 验证了第 1、2 题的计算，需要我把题目写进《期末复习计划》吗？`,
    steps: [
      { kind: 'thinking', text: '用户想复习基尔霍夫定律。先看知识库目录，找到相关笔记，再检索课程资料里的例题，最后出题并用 Python 验算答案。' },
      { kind: 'tool', name: 'list_tree', input: '{}', output: JSON.stringify({ ok: true, data: { name: 'list_tree', result: entries.filter(e => e.kind !== 'agent').map(({ id, title, kind }) => ({ id, title, kind })) } }) },
      { kind: 'tool', name: 'read_entry', input: JSON.stringify({ id: ids.kcl }), output: readOutput('kcl', '基尔霍夫定律') },
      { kind: 'tool', name: 'search_course_materials', input: JSON.stringify({ query: '基尔霍夫 例题' }), output: JSON.stringify({ hits: [
        { title: '电路（第 6 版）第 1 章 例 1-6', source: 'course' }, { title: '电路分析基础 习题 1.12', source: 'course' }, { title: '2024 春 电路期中试卷 第 2 题', source: 'course' },
      ] }) },
      { kind: 'thinking', text: '例题足够。出 3 道由浅入深的自测题：节点电流、独立方程数、电流源支路概念题。前两题有数值答案，用沙箱算一遍。' },
      { kind: 'tool', name: 'bash', input: "python3 -c \"n,b=4,6; print('KCL', 3+2-1, 'A'); print('KVL', b-n+1)\"", output: 'KCL 4 A\nKVL 3' },
    ],
  },
];

const localTurn = {
  content: '在本机沙箱里统计一下我电路实验的数据，算出每条支路的电阻。',
  reply: `已在**本机 Docker 沙箱**中完成计算（容器与互联网隔离）：

| 支路 | I (mA) | U (V) | R = U / I (Ω) |
| --- | --- | --- | --- |
| R1 | 12.4 | 3.10 | 250.0 |
| R2 | 7.9 | 1.98 | 250.6 |
| R3 | 4.5 | 1.12 | 248.9 |

三条支路阻值都在 250 Ω ± 0.5% 内，与标称值一致；KCL 校验 12.4 ≈ 7.9 + 4.5 mA 成立。`,
  steps: [
    { kind: 'thinking', text: '数据在《电路实验报告模板》里。先读笔记，再把表格写成 CSV 交给 Python 计算，并顺手校验 KCL。' },
    { kind: 'tool', name: 'read_entry', input: JSON.stringify({ id: ids.lab }), output: readOutput('lab', '电路实验报告模板') },
    { kind: 'tool', name: 'bash', input: "cat > lab.csv <<'EOF'\nbranch,i_ma,u_v\nR1,12.4,3.10\nR2,7.9,1.98\nR3,4.5,1.12\nEOF\npython3 calc.py lab.csv", output: 'R1 250.0\nR2 250.6\nR3 248.9\nKCL 12.4 == 12.4 OK' },
  ],
};

const newer = 'c4f1a9e2b7d3058e6a1f9c2d4b8e7a3f6c9d0b12';
const older = '7a3e9d1c5b2f8046e3a7c1d9b5f2e8a4c6d0e3f1';

function initialState() {
  return {
    sessions: { [ids.session]: { id: ids.session, entry_id: ids.tutor, messages: cloudTurn, created_at: at(600), updated_at: at(601) } },
    entryById: Object.fromEntries(entries.map(entry => [entry.id, { ...entry }])),
    localHold: null,
    sandboxRunning: false,
  };
}

const model = {
  configured: true, source: 'product', name: 'deepseek-flash', choices: ['deepseek-flash', 'gpt-6-sol-lite'],
  agent: { sandbox: true, tools: ['list_tree', 'read_entry', 'create_entry', 'update_entry', 'search_course_materials', 'campus_timetable', 'campus_exams', 'campus_study_rooms', 'bash'] },
  quota: { limit: 200, used: 37, remaining: 163 },
  windows: [
    { id: '5h', limit: 40, used: 9, remaining: 31, resets_at: at(900) },
    { id: '7d', limit: 200, used: 37, remaining: 163, resets_at: at(6000) },
  ],
};

const deck = { id: hex(0xa2), name: '电路分析', created_at: at(0), updated_at: at(540) };
const cards = [
  ['KCL 的内容是什么？', '任一节点流入电流之和等于流出电流之和', ['电路', 'KCL']],
  ['独立 KVL 方程个数', 'b − n + 1', ['电路', 'KVL']],
  ['戴维南等效电阻怎么求？', '独立源置零后求端口电阻；含受控源用外加电源法', ['电路']],
  ['sin x 的三阶麦克劳林展开', 'x − x³/3! + o(x³)', ['高数']],
].map(([front, back, tags], index) => ({ id: hex(0x100 + index), deck_id: deck.id, front, back, tags,
  due: at(900), interval: 3, ease: 250, reps: 2, lapses: 0, created_at: at(100), updated_at: at(540) }));

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(route, state) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const p = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
  let m;
  if (p === '/auth/session') return json(route, 200, identity);
  if (p === '/vault/status') return json(route, 200, { configured: false });
  if (p === '/libraries' && method === 'GET') return json(route, 200, { libraries: [library] });
  if ((m = p.match(/^\/libraries\/([0-9a-f]{32})\/entries$/)) && method === 'GET') {
    return json(route, 200, { entries: Object.values(state.entryById).map(entry => ({ ...entry, body: undefined })) });
  }
  if ((m = p.match(/^\/entries\/([0-9a-f]{32})$/))) {
    const found = state.entryById[m[1]];
    if (!found) return json(route, 404, { error: { id: 'entry_not_found' } });
    if (method === 'PATCH') Object.assign(found, request.postDataJSON());
    return json(route, 200, { entry: found });
  }
  if ((m = p.match(/^\/entries\/([0-9a-f]{32})\/history$/))) {
    const file = `notes/天大学习知识库/电路分析/${state.entryById[m[1]]?.title}.md`;
    const revision = url.searchParams.get('revision');
    if (revision) return json(route, 200, { revision, path: file, content: revision === older ? bodies.kcl.split('## 易错点')[0] : state.entryById[m[1]]?.body });
    return json(route, 200, { path: file, commits: [
      { sha: newer, message: '补充易错点与习题清单', author: 'TJUClaw', date: '2026-09-28T13:20:00Z' },
      { sha: 'e19b04d7c2a85f3e6d1b9a04c7e2f58d3a6b1c09', message: '电路课助教：添加 KVL 独立方程表', author: 'TJUClaw Agent', date: '2026-09-27T12:05:00Z' },
      { sha: older, message: '新建笔记：基尔霍夫定律', author: 'TJUClaw', date: '2026-09-25T02:40:00Z' },
    ] });
  }
  if (p === '/library/git') return json(route, 200, { git: { enabled: true, state: 'synced', revision: newer, notes: 7, synced_at: '2026-09-28T13:20:05Z' } });
  if ((m = p.match(/^\/entries\/([0-9a-f]{32})\/sessions$/))) {
    const list = Object.values(state.sessions).filter(s => s.entry_id === m[1]);
    if (method === 'POST') {
      const created = list[0] ?? { id: hex(0xd2), entry_id: m[1], messages: [], created_at: at(700), updated_at: at(700) };
      state.sessions[created.id] = created;
      return json(route, 201, { session: created });
    }
    return json(route, 200, { sessions: list.map(({ id, entry_id, created_at, updated_at }) => ({ id, entry_id, created_at, updated_at })) });
  }
  if ((m = p.match(/^\/sessions\/([0-9a-f]{32})$/))) return json(route, 200, { session: state.sessions[m[1]] });
  if ((m = p.match(/^\/sessions\/([0-9a-f]{32})\/local-turns$/))) {
    return json(route, 200, { tool_grant: 'a'.repeat(64), turn: 2, owner_id: identity.id, session_id: m[1], entry_id: ids.tutor, profile: 'study-agent', model: model.name });
  }
  if ((m = p.match(/^\/sessions\/([0-9a-f]{32})\/local-turns\/finish$/))) {
    const body = request.postDataJSON();
    const session = state.sessions[m[1]];
    session.messages = [...session.messages,
      { role: 'user', content: body.content, client_request_id: body.client_request_id, created_at: at(720) },
      { role: 'assistant', content: body.reply, steps: body.steps, tools: body.steps.filter(s => s.kind === 'tool').map(s => s.name), created_at: at(721) }];
    return json(route, 200, { session });
  }
  if (p === '/sandbox/local/runtime') return json(route, 200, { grant: 'b'.repeat(64), expires_at: at(1400), model: model.name, models: model.choices });
  if (p === '/account/model') return json(route, 200, { model });
  if (p === '/market' || p.endsWith('/publications')) return json(route, 200, { publications: [] });
  if (p.endsWith('/search')) return json(route, 200, { hits: [] });
  if (p === '/reviews') return json(route, 200, { reviews: [] });
  if (p === '/decks') return json(route, 200, { decks: [deck] });
  if (p === '/cards') return json(route, 200, { cards });
  if (p === `/decks/${deck.id}/study-summary`) return json(route, 200, { last_reviewed_at: at(540) });
  return json(route, 404, { error: { id: 'not_found' } });
}

/** Opens the app at the product origin, served from the local preview build. */
async function openApp(page, state, { tauri = false, runtime = 'cloud' } = {}) {
  await page.addInitScript(({ identityId, libraryId, tauri, runtime }) => {
    localStorage.setItem(`tjuclaw.workspace.vault.v1.${identityId}.${libraryId}`, JSON.stringify({ version: 1, salt: 'ZGVtby1zYWx0', verifier: 'demo-verifier', created_at: '2026-09-01T00:00:00.000Z' }));
    sessionStorage.setItem(`tjuclaw.workspace.unlock.v1.${identityId}.${libraryId}`, 'unlocked');
    localStorage.setItem('tjuclaw.agent.runtime.v1', runtime);
    localStorage.setItem('tjuclaw.notice-banner.v2', '1');
    if (!tauri) return;
    // Minimal Tauri bridge: only the local-sandbox commands answer; everything
    // else rejects so the app takes its browser fallbacks.
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 0,
      invoke: (cmd, args) => window.__demoInvoke(cmd, args),
    };
  }, { identityId: identity.id, libraryId: library.id, tauri, runtime });
  if (tauri) {
    await page.exposeFunction('__demoInvoke', async (cmd, args) => {
      if (cmd === 'local_sandbox_status') return { docker: true, images: true, running: state.sandboxRunning };
      if (cmd === 'local_sandbox_prepare') return null;
      if (cmd === 'local_sandbox_start') { state.sandboxRunning = true; return null; }
      if (cmd === 'local_sandbox_turn') {
        if (state.localHold) await state.localHold;
        return { content: localTurn.reply, steps: localTurn.steps };
      }
      throw new Error(`unsupported command ${cmd}: ${JSON.stringify(args ?? {}).slice(0, 40)}`);
    });
  }
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return mockApi(route, state);
    const response = await route.fetch({ url: PREVIEW + url.pathname + url.search });
    return route.fulfill({ response });
  });
  await page.goto(`${ORIGIN}/workspace`);
  await expect(page.locator('.obsidian-app')).toBeVisible();
}

async function shot(page, name) {
  await page.mouse.move(0, 0);
  // Scrolling a step into view can nudge the app shell sideways; capture it aligned.
  await page.evaluate(() => {
    window.scrollTo(0, window.scrollY);
    document.querySelectorAll('*').forEach(el => { if (el.scrollLeft > 0 && !el.matches('pre, pre *, table, .table-wrap')) el.scrollLeft = 0; });
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

async function expectFitsWidth(page) {
  const width = await page.locator('.chat-message.assistant').last().evaluate(el => el.getBoundingClientRect().right);
  expect(width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
}

async function openNote(page, folderTitle, title) {
  const tree = page.locator('.obsidian-tree');
  const target = tree.getByRole('button', { name: title, exact: true });
  if (!await target.isVisible() && folderTitle) await tree.getByRole('button', { name: folderTitle, exact: true }).click();
  await target.click();
  await expect(page.locator('.note-title')).toHaveValue(title);
}

async function openTutor(page) {
  // Conversations are listed by their first question.
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.locator('.conversation-row').filter({ hasText: '帮我梳理一下基尔霍夫定律' }).click();
  await expect(page.getByRole('log', { name: '会话记录' })).toContainText('基尔霍夫');
}

async function expandSteps(reply, stepPattern) {
  // Thinking and each tool call are rows of their own; open the thinking.
  const steps = reply.getByRole('list', { name: '思考与工具调用' });
  await steps.getByRole('button', { name: /思考过程/ }).first().click();
  if (stepPattern) await steps.getByRole('button', { name: stepPattern }).click();
  return steps;
}

for (const scheme of ['light', 'dark']) {
  test.describe(`desktop 16:9 ${scheme}`, () => {
    test.use({ ...DESKTOP, colorScheme: scheme });

    test('knowledge workspace, graph and note history', async ({ page }) => {
      const state = initialState();
      await openApp(page, state);
      await openNote(page, '电路分析', '基尔霍夫定律');
      await expect(page.locator('.workspace-statusbar')).toContainText('Git 已同步');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await shot(page, `desktop-${scheme}-01-workspace-edit`);
      await page.getByRole('button', { name: '阅读模式' }).click();
      await expect(page.locator('.markdown-preview table').first()).toBeVisible();
      await shot(page, `desktop-${scheme}-02-workspace-read`);
      await page.getByRole('button', { name: '编辑模式' }).click();
      if (scheme === 'dark') return;

      await page.getByRole('button', { name: '知识图谱' }).click();
      await expect(page.getByRole('dialog').getByText(/篇笔记 · \d+ 条双向链接/)).toBeVisible();
      await shot(page, `desktop-${scheme}-03-knowledge-graph`);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: '版本历史' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: /新建笔记：基尔霍夫定律/ }).click();
      await expect(dialog.locator('.markdown-preview')).toContainText('基尔霍夫电流定律');
      await shot(page, `desktop-${scheme}-04-note-history`);
    });

    test('Agent session with expanded thinking chain', async ({ page }) => {
      await openApp(page, initialState());
      await openTutor(page);
      const reply = page.locator('.chat-message.assistant').last();
      const steps = await expandSteps(reply, /运行命令/);
      await expect(steps.locator('pre').last()).toContainText('KVL 3');
      await shot(page, `desktop-${scheme}-05-agent-thinking`);
    });

    test('sandbox runtime: cloud, then local Docker running a turn', async ({ page }) => {
      const state = initialState();
      await openApp(page, state, { tauri: true, runtime: 'cloud' });
      const openModelSettings = async () => {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /模型/ }).click();
        await expect(page.getByRole('heading', { name: 'Agent 运行位置' })).toBeVisible();
      };
      await openModelSettings();
      await expect(page.getByRole('dialog')).toContainText('Docker 已就绪');
      await shot(page, `desktop-${scheme}-06-sandbox-cloud`);

      await page.getByRole('group', { name: 'Agent 运行位置' }).getByRole('button', { name: '本机' }).click();
      await expect(page.getByRole('dialog')).toContainText('本机沙箱已就绪');
      await expect(page.getByRole('dialog')).toContainText('本机沙箱正在运行');
      await shot(page, `desktop-${scheme}-07-sandbox-local-running`);
      await page.getByRole('button', { name: '关闭设置' }).click();

      await openTutor(page);
      let release;
      state.localHold = new Promise(resolve => { release = resolve; });
      await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill(localTurn.content);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect(page.getByRole('status', { name: /正在处理/ })).toBeVisible();
      await shot(page, `desktop-${scheme}-08-local-turn-running`);
      release();
      const reply = page.locator('.chat-message.assistant').last();
      await expect(reply).toContainText('250 Ω');
      const steps = await expandSteps(reply);
      await reply.locator('table').scrollIntoViewIfNeeded();
      await shot(page, `desktop-${scheme}-09-local-turn-done`);
      await steps.getByRole('button', { name: /运行命令/ }).click();
      await expect(steps.locator('pre').last()).toContainText('KCL 12.4');
      await steps.locator('pre').last().scrollIntoViewIfNeeded();
      await shot(page, `desktop-${scheme}-10-local-turn-command`);
    });
  });
}

test.describe('mobile', () => {
  test.use({ ...MOBILE, colorScheme: 'light' });

  test('workspace, drawer and Agent thinking chain on a phone', async ({ page }) => {
    await openApp(page, initialState());
    await page.getByRole('button', { name: '打开侧栏' }).click();
    const tree = page.locator('.obsidian-tree');
    await expect(tree.getByRole('button', { name: '基尔霍夫定律', exact: true })).toBeVisible();
    await shot(page, 'mobile-01-drawer');
    await tree.getByRole('button', { name: '基尔霍夫定律', exact: true }).click();
    await expect(page.locator('.note-title')).toHaveValue('基尔霍夫定律');
    await shot(page, 'mobile-02-note');

    await page.getByRole('button', { name: '打开侧栏' }).click();
    await openTutor(page);
    const reply = page.locator('.chat-message.assistant').last();
    await reply.scrollIntoViewIfNeeded();
    await expectFitsWidth(page);
    await shot(page, 'mobile-03-agent-reply');
    const steps = await expandSteps(reply, /检索课程资料/);
    await steps.scrollIntoViewIfNeeded();
    await expectFitsWidth(page);
    await shot(page, 'mobile-04-agent-thinking');
  });

  test('dark mode Agent chain and model quota', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openApp(page, initialState());
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await openTutor(page);
    const reply = page.locator('.chat-message.assistant').last();
    const steps = await expandSteps(reply, /运行命令/);
    await steps.getByRole('button', { name: /运行命令/ }).scrollIntoViewIfNeeded();
    await expectFitsWidth(page);
    await shot(page, 'mobile-05-dark-agent-thinking');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: /模型/ }).click();
    await expect(page.getByRole('dialog')).toContainText('TJUClaw');
    await page.locator('.settings-sections [aria-current="page"]').evaluate(el => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
    await shot(page, 'mobile-06-dark-model-quota');
  });
});
