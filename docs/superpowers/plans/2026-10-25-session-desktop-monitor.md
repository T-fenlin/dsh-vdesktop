# 会话内虚拟桌面监视与接管 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `dsh-vdesktop` 的右下角全局浮窗替换为每会话独立的“虚拟桌面”标签页，提供大画面、操作日志和用户手动接管，并发布 `dsh-vdesktop@0.2.0`。

**Architecture:** Host 侧新增 `session-runtime.js`，负责按会话创建隔离的 sidecar / 浏览器、操作日志、画面和接管锁；`index.js` 只保留工具定义并经由该模块归属到调用会话。Client 侧用 `conversation.view` 注册会话内标签页，通过按会话过滤的 WebSocket 接收画面与日志，通过新的 Host Remote 动作提交接管操作。旧 `shell.overlay` 浮窗删除。

**Tech Stack:** Node.js 22+ ESM、Cordis 插件、`@deepseek-ai/schemastery`、`ws`、React（由宿主模块表提供）、Rust sidecar（既有 `dshv.exe`）、Node 内置 `node:test`。

## Global Constraints

- 包名固定 `dsh-vdesktop`，发布版本固定 `0.2.0`；发布前必须移除 `private`。
- 保留工具名 `vdesk_*`、`browser_*` 及其现有参数，不改变已记录的 Windows 限制。
- 目标平台 Windows x64；`dshv.exe` 从发布包的 `sidecar/target/release/dshv.exe` 读取。
- 每个会话独立 sidecar、桌面名称空间、浏览器、日志和画面；不允许跨会话串流。
- 默认观看模式；只有用户明确接管后才允许 UI 操作，接管期间本会话 Agent 操作必须被拒绝。
- 任何 UI 文本都经 Client locale 服务；颜色只用 `--dsw-alias-*` 主题令牌。
- 不新增不可忽略的 Session 事件；不改用户消息、内置标签页或其他插件。
- 每个任务先写失败测试，确认失败原因后再写最小实现；完成后提交。
- 不发布 `node_modules`、`sidecar/target` 除 release exe 外的内容、`docs/evidence` 或临时截图。

---

## File Structure

- Create `session-runtime.js` — 会话级运行环境、桌面映射、日志/帧、接管锁、操作分派。唯一拥有 `Map<SessionId, SessionRuntime>` 的模块。
- Create `monitor-protocol.js` — 纯函数：帧签名、日志条目构造、缩放坐标换算、WebSocket 消息过滤。无进程或网络副作用，便于单元测试。
- Create `test/monitor-protocol.test.mjs` — 协议与坐标换算测试。
- Create `test/session-runtime.test.mjs` — 用假 sidecar / 假浏览器验证隔离、锁、生命周期。
- Modify `index.js` — 移除 `Monitor` 与 `shell.overlay` 相关逻辑，工具通过 `session-runtime.js` 执行；新增 Remote 方法供 Client 调用。
- Modify `browser.js` — 允许每实例指定不同调试端口和用户目录；确保 `close()` 幂等。
- Modify `client.js` — 完整替换为 `conversation.view` 标签页：大画面、日志、观看/接管、错误与空状态。
- Modify `cordis.patch.yml` — 保持工具注入，新增可选 `webServer` 注入说明不阻塞无 HTTP 组合。
- Modify `locale/en.json`、`locale/zh.json` — 标签页与界面文案。
- Modify `package.json` — 版本、公开字段、`files`、`test` 脚本、发布元数据。
- Modify `README.md` — 新入口、接管、隔离与发布安装说明。
- Delete from `client.js` — 旧的 `shell.overlay` 浮窗实现（整体重写文件）。
- Delete `scripts/test-monitor.mjs` 的旧全局假设 — 更新为按会话验证；保留真实 WebSocket 集成覆盖。

### Task 1: 纯监视协议与坐标换算

**Files:**
- Create: `monitor-protocol.js`
- Test: `test/monitor-protocol.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: `frameSignature({ pngBase64, width, height }) -> string`；`toTargetPoint({ imageX, imageY, imageWidth, imageHeight, targetWidth, targetHeight }) -> { x, y }`；`normalizeJournalEntry(entry) -> object`；`belongsToSession(message, sessionId) -> boolean`。

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameSignature, toTargetPoint, normalizeJournalEntry, belongsToSession } from '../monitor-protocol.js';

test('frame signatures distinguish different pixel content with the same length and tail', () => {
  const a = { pngBase64: 'A'.repeat(200) + 'TAIL', width: 10, height: 10 };
  const b = { pngBase64: 'B'.repeat(200) + 'TAIL', width: 10, height: 10 };
  assert.notEqual(frameSignature(a), frameSignature(b));
});

test('toTargetPoint maps scaled image coordinates to target pixels', () => {
  assert.deepEqual(
    toTargetPoint({ imageX: 320, imageY: 180, imageWidth: 640, imageHeight: 360, targetWidth: 1280, targetHeight: 720 }),
    { x: 640, y: 360 },
  );
});

test('toTargetPoint clamps outside points to the target bounds', () => {
  assert.deepEqual(
    toTargetPoint({ imageX: -5, imageY: 999, imageWidth: 640, imageHeight: 360, targetWidth: 1280, targetHeight: 720 }),
    { x: 0, y: 720 },
  );
});

test('journal entries keep only display-safe fields and a bounded argument summary', () => {
  const entry = normalizeJournalEntry({
    at: 1,
    tool: 'vdesk_type',
    args: { name: 'task-1', text: 'x'.repeat(500), token: 'secret' },
    ok: true,
    ms: 12,
  });
  assert.equal(entry.tool, 'vdesk_type');
  assert.equal(entry.args.text.length, 120);
  assert.equal(entry.args.token, undefined);
});

test('messages are visible only to their owning session', () => {
  assert.equal(belongsToSession({ sessionId: 's1' }, 's1'), true);
  assert.equal(belongsToSession({ sessionId: 's2' }, 's1'), false);
  assert.equal(belongsToSession({ sessionId: undefined }, 's1'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/monitor-protocol.test.mjs`
Expected: FAIL with `Cannot find module '../monitor-protocol.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
const MAX_ARG_TEXT = 120;
const ARG_ALLOWLIST = new Set(['name', 'desktop', 'x', 'y', 'dy', 'text', 'keys', 'button', 'count', 'from', 'to', 'window', 'selector', 'url']);

export function frameSignature({ pngBase64, width, height }) {
  return `${width}x${height}:${pngBase64.length}:${hash(pngBase64)}`;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function toTargetPoint({ imageX, imageY, imageWidth, imageHeight, targetWidth, targetHeight }) {
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  return {
    x: Math.round(clamp(imageX / imageWidth, 1) * targetWidth),
    y: Math.round(clamp(imageY / imageHeight, 1) * targetHeight),
  };
}

export function normalizeJournalEntry(entry) {
  const args = {};
  for (const [key, value] of Object.entries(entry.args ?? {})) {
    if (!ARG_ALLOWLIST.has(key)) continue;
    args[key] = typeof value === 'string' ? value.slice(0, MAX_ARG_TEXT) : value;
  }
  return { at: entry.at, tool: entry.tool, args, ok: Boolean(entry.ok), error: entry.error?.slice(0, 240), ms: entry.ms };
}

export function belongsToSession(message, sessionId) {
  return Boolean(message && message.sessionId === sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/monitor-protocol.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add monitor-protocol.js test/monitor-protocol.test.mjs
git commit -m "feat: add per-session monitor protocol helpers"
```

### Task 2: 会话级运行环境与隔离

**Files:**
- Create: `session-runtime.js`
- Test: `test/session-runtime.test.mjs`
- Modify: `browser.js`

**Interfaces:**
- Consumes: `monitor-protocol.js` 的 `frameSignature`、`normalizeJournalEntry`。
- Produces: `class SessionRuntimes`，方法 `forSession(sessionId) -> SessionRuntime`、`disposeSession(sessionId)`、`disposeAll()`；`SessionRuntime` 方法 `runTool(name, args, execute)`、`snapshot()`、`beginTakeover()`、`endTakeover()`、`applyUiInput(payload)`、`recordFrame(...)`。构造函数接受 `{ createSidecar, createBrowser, capture }` 以便测试注入。

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRuntimes } from '../session-runtime.js';

function fakeEnv() {
  const calls = [];
  const sidecar = {
    call: async (method, params) => { calls.push({ method, params }); return { ok: true }; },
    stop: () => calls.push({ method: 'stop' }),
  };
  const browser = { close: () => calls.push({ method: 'browser.close' }) };
  return { calls, sidecar, browser };
}

test('each session gets its own runtime and desktop name namespace', () => {
  const envs = new Map();
  const runtimes = new SessionRuntimes({
    createSidecar: (sessionId) => {
      const env = fakeEnv();
      envs.set(sessionId, env);
      return env.sidecar;
    },
    createBrowser: (sessionId) => envs.get(sessionId).browser,
    capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
  });
  const a = runtimes.forSession('s1');
  const b = runtimes.forSession('s2');
  assert.notEqual(a, b);
  assert.equal(a.scopeName('task'), 's1:task');
  assert.equal(b.scopeName('task'), 's2:task');
});

test('takeover blocks agent tools in that session only', async () => {
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({ call: async () => ({ ok: true }), stop() {} }),
    createBrowser: () => ({ close() {} }),
    capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
  });
  const a = runtimes.forSession('s1');
  const b = runtimes.forSession('s2');
  a.beginTakeover();
  await assert.rejects(() => a.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => ({})), /接管/);
  await assert.doesNotReject(() => b.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => ({})));
  a.endTakeover();
  await assert.doesNotReject(() => a.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => ({})));
});

test('disposing a session stops its sidecar and browser', () => {
  const stopped = [];
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({ call: async () => ({}), stop: () => stopped.push('sidecar') }),
    createBrowser: () => ({ close: () => stopped.push('browser') }),
    capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
  });
  const a = runtimes.forSession('s1');
  a.browser();
  runtimes.disposeSession('s1');
  assert.deepEqual(stopped.sort(), ['browser', 'sidecar']);
  assert.throws(() => runtimes.forSession('s1').snapshot(), /disposed|不存在/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session-runtime.test.mjs`
Expected: FAIL with `Cannot find module '../session-runtime.js'`.

- [ ] **Step 3: Write minimal implementation**

`session-runtime.js` 实现：
- `SessionRuntimes` 保存 `Map`，`forSession` 延迟创建；`disposeSession` 幂等并清理订阅者。
- `SessionRuntime` 持有 `sessionId`、`journal`（上限 50）、`frame`、`takeover`、`subscribers`。
- `scopeName(name)` 返回 `${sessionId}:${name}`，并拒绝包含空白的名称。
- `runTool(name, args, execute)`：接管中抛 `new Error('该会话正在被用户接管，请先交还 Agent')`；执行前记录开始时间，执行后记录 `normalizeJournalEntry` 并广播；失败同样记录后抛出。
- `snapshot()` 返回 `{ sessionId, takeover, frame, journal, state }`。
- `applyUiInput(payload)` 在未接管时抛错；按 payload 调用 `sidecar.call('input.*')` 或 `browser` 方法；成功后捕获帧。
- `dispose()` 清理 sidecar、browser 与订阅。

同步修改 `browser.js`：构造参数 `port` 必填由调用方传入，`userDataDir` 每次独立；`close()` 用 `if (!this.proc && !this.cdp) return;` 保证幂等。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/session-runtime.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add session-runtime.js browser.js test/session-runtime.test.mjs
git commit -m "feat: isolate virtual desktop runtime by session"
```

### Task 3: Host 工具归属会话与 Remote 控制入口

**Files:**
- Modify: `index.js`
- Modify: `cordis.patch.yml`
- Test: `test/session-runtime.test.mjs`

**Interfaces:**
- Consumes: `SessionRuntimes`、`SessionRuntime`。
- Produces: 每个工具仍注册同一 schema；执行时通过 `ctx.agents.currentInitiator()?.id` 取会话并调用 `runtimes.forSession(id).runTool(...)`。新增 Remote 命名空间 `vdesk`，方法 `snapshot(sessionId)`、`takeover(sessionId)`、`release(sessionId)`、`input(sessionId, payload)`。

- [ ] **Step 1: Write the failing test**

在 `test/session-runtime.test.mjs` 增加：

```js
test('snapshot never exposes another session journal', async () => {
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({ call: async () => ({}), stop() {} }),
    createBrowser: () => ({ close() {} }),
    capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
  });
  const a = runtimes.forSession('s1');
  const b = runtimes.forSession('s2');
  await a.runTool('vdesk_list', {}, async () => ({}));
  assert.equal(a.snapshot().journal.length, 1);
  assert.equal(b.snapshot().journal.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session-runtime.test.mjs`
Expected: FAIL because journal isolation is not yet implemented.

- [ ] **Step 3: Write minimal implementation**

- 在 `index.js` 顶部引入 `SessionRuntimes`。
- `apply(ctx, config)` 中创建 `const runtimes = new SessionRuntimes({...})`，并在 `ctx.effect` 里注册 `disposeAll`。
- 删除旧 `Monitor` 类与 `shell.overlay` 相关注册。
- 把 `watch(def)` 改为：取 `ctx.agents.currentInitiator()?.id`；没有会话则抛 `没有活动会话`；`runtimes.forSession(id).runTool(def.name, p, () => def.execute(p))`。
- 截图推送改由 `SessionRuntime` 负责；工具本身不再直接 broadcast。
- 在 `cordis.patch.yml` 的 `inject` 保持 `['tools']`，但通过 `ctx.inject(['agents', 'webServer'], ...)` 建立可选依赖。
- 注册 Remote 方法时确保调用方只能访问自身会话；若 Remote 层不提供会话身份，方法必须显式接收 `sessionId` 并在服务端校验当前活跃会话。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/session-runtime.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add index.js cordis.patch.yml test/session-runtime.test.mjs
git commit -m "feat: attribute virtual desktop tools to their session"
```

### Task 4: 按会话过滤的 WebSocket 与画面推送

**Files:**
- Modify: `session-runtime.js`
- Modify: `index.js`
- Create: `test/ws-filter.test.mjs`

**Interfaces:**
- Consumes: `belongsToSession`、`SessionRuntime` 的订阅接口。
- Produces: `/vdesk/live?session=<id>` 只接收该会话快照与后续消息；连接时发送 `{ type: 'snapshot', ... }`，之后发送 `{ type: 'journal' }` 与 `{ type: 'frame' }`。

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { belongsToSession } from '../monitor-protocol.js';

test('a socket subscribed to s1 never accepts s2 frames', () => {
  assert.equal(belongsToSession({ sessionId: 's2', type: 'frame' }, 's1'), false);
  assert.equal(belongsToSession({ sessionId: 's1', type: 'frame' }, 's1'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ws-filter.test.mjs`
Expected: FAIL if `belongsToSession` missing; already passing means this test is redundant — instead assert URL parsing helper does not exist, add `sessionFromUpgradeUrl`, then implement it.

- [ ] **Step 3: Write minimal implementation**

- 在 `monitor-protocol.js` 增加 `sessionFromUpgradeUrl(url)`：解析 `/vdesk/live?session=...`，缺失或非法返回 `undefined`。
- 在 `index.js` 的 `webServer.registerUpgrade` 中按 URL 取 `sessionId`，没有则 `socket.destroy()`。
- 只向该 socket 发送对应 `SessionRuntime` 的快照和订阅消息；不再向所有 socket 广播。
- 更新 `scripts/test-monitor.mjs` 为两个连接（两个会话），断言不会串流。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ws-filter.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add monitor-protocol.js index.js session-runtime.js scripts/test-monitor.mjs test/ws-filter.test.mjs
git commit -m "feat: stream monitor data per session"
```

### Task 5: 会话内“虚拟桌面”标签页

**Files:**
- Rewrite: `client.js`
- Modify: `locale/en.json`
- Modify: `locale/zh.json`
- Test: `test/client-contract.test.mjs`

**Interfaces:**
- Consumes: `conversation.view` 的 `sessionId`、`ctx.remote` 调用、`/vdesk/live?session=` WebSocket。
- Produces: 注册 id `virtual-desktop`，`order: 20`（位于轨迹之后），label 使用 locale。

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('client registers a conversation view, not a shell overlay', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /conversation\.view/);
  assert.doesNotMatch(source, /shell\.overlay/);
});

test('client never hard-codes colors outside theme tokens', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(source, /rgba?\(/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/client-contract.test.mjs`
Expected: FAIL because `client.js` still uses `shell.overlay`.

- [ ] **Step 3: Write minimal implementation**

Client 组件结构：
- 顶栏：会话桌面选择、连接状态点、模式徽标、“接管操作/交还 Agent”按钮。
- 主区：`img` 显示最新 PNG，保持比例；`onPointerDown/Move/Up` 只在接管时发送 `vdesk_click` / `vdesk_drag`；`onWheel` 发送 `vdesk_scroll`；画面区域可聚焦，`onKeyDown` 把文本和组合键发给 Host。
- 侧栏/下方：最近 50 条日志，显示时间、工具、摘要、耗时、成败；点击日志可定位对应桌面。
- 空状态：提示“先让 Agent 打开一个程序或网页”。
- 错误状态：WebSocket 断开显示“正在重连”，保留旧画面但加“画面可能已过期”标记。
- 所有文案走 `ctx.locale.bind('dsh-vdesktop')`；在 locale JSON 增加 `view.*` 键。
- 不读取其他插件 DOM，不引用 `@deepseek-ai/dsh-client-ui-primitives`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/client-contract.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add client.js locale/en.json locale/zh.json test/client-contract.test.mjs
git commit -m "feat: add per-session virtual desktop view"
```

### Task 6: 手动接管输入路径

**Files:**
- Modify: `session-runtime.js`
- Modify: `client.js`
- Modify: `index.js`
- Test: `test/session-runtime.test.mjs`

**Interfaces:**
- Consumes: `SessionRuntime.applyUiInput`。
- Produces: UI 输入动作 `click`、`drag`、`scroll`、`type`、`key`，均由 `applyUiInput` 调用现有 sidecar/browser 方法，并返回明确结果。

- [ ] **Step 1: Write the failing test**

```js
test('UI input is rejected before takeover and accepted after it', async () => {
  const calls = [];
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({ call: async (method, params) => { calls.push({ method, params }); return { ok: true }; }, stop() {} }),
    createBrowser: () => ({ close() {} }),
    capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
  });
  const a = runtimes.forSession('s1');
  await assert.rejects(() => a.applyUiInput({ kind: 'click', desktop: 'task', x: 10, y: 20 }), /接管/);
  a.beginTakeover();
  await a.applyUiInput({ kind: 'click', desktop: 'task', x: 10, y: 20 });
  assert.equal(calls.at(-1).method, 'input.click');
  assert.equal(calls.at(-1).params.desktop, 's1:task');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session-runtime.test.mjs`
Expected: FAIL because `applyUiInput` is missing or does not translate the desktop name.

- [ ] **Step 3: Write minimal implementation**

- `applyUiInput` 校验 `takeover === true`，按 `kind` 白名单分派；桌面参数统一经 `scopeName`。
- `click` → `input.click`；`drag` → `input.drag`；`scroll` → `input.scroll`；`type` → `input.type`；`key` → `input.key`；浏览器动作通过 `browser()` 实例的方法。
- 输入成功后触发截图并推帧；失败抛出可读错误。
- Client 对鼠标事件做坐标换算；键盘只在接管和聚焦时发送，`event.preventDefault()` 阻止会话编辑器收到按键。
- 交还时清空拖拽状态和焦点状态。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/session-runtime.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add session-runtime.js client.js index.js test/session-runtime.test.mjs
git commit -m "feat: allow explicit per-session takeover input"
```

### Task 7: 发布元数据与文档

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `locale/en.json`
- Modify: `locale/zh.json`
- Test: `test/package-contract.test.mjs`

**Interfaces:**
- Consumes: 全部先前任务。
- Produces: 可 `npm pack` 的公开包，版本 `0.2.0`。

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package is public, versioned 0.2.0, and ships runtime files', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.2.0');
  assert.equal(pkg.private, undefined);
  for (const file of ['index.js', 'client.js', 'session-runtime.js', 'monitor-protocol.js', 'sidecar/target/release/dshv.exe']) {
    assert.ok(pkg.files.includes(file), `${file} missing from files`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/package-contract.test.mjs`
Expected: FAIL because version is `0.1.0`, `private` is true, and new files are absent.

- [ ] **Step 3: Write minimal implementation**

- `package.json`：`version: "0.2.0"`，删除 `private`，加入 `license: "MIT"`、`repository`、`keywords`、`os: ["win32"]`、`cpu: ["x64"]`、`scripts.test: "node --test"`；`files` 补入 `session-runtime.js`、`monitor-protocol.js`、`test/` 不发布；保留 `icon.svg`、locale、sidecar exe。
- 如果仓库地址未知，`repository` 留空对象会失败发布，需在发布前向用户确认；不要伪造 URL。
- README 更新：会话标签页、观看/接管、每会话隔离、npm 安装、未登录时先 `npm login`。
- locale 增加完整中英文 `view.*` 文案，`meta.description` 说明会话内查看与接管。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/package-contract.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add package.json README.md locale/en.json locale/zh.json test/package-contract.test.mjs
git commit -m "chore: prepare 0.2.0 package metadata"
```

### Task 8: 全量验证、安装与发布

**Files:**
- Modify: `docs/verification.md`
- Test: 全部 `test/*.test.mjs` 与真实 Windows 验收。

- [ ] **Step 1: Run all automated tests**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 2: Build the sidecar and verify executable**

Run: `cargo build --release --manifest-path sidecar/Cargo.toml`
Expected: exit 0，`sidecar/target/release/dshv.exe` 存在。

- [ ] **Step 3: Run real acceptance checks**

Run: `python scripts/acceptance.py`
Expected: 已知 Chromium 桌面限制不变；记事本桌面创建、截图、中文输入、关闭均通过。记录实际结果到 `docs/verification.md`，不得把未验证项写成通过。

- [ ] **Step 4: Install locally and enable**

使用 `plugin_manager` `install_bundle` 指向 `D:\developmentProjects\dsh-vdesktop`，然后 `set_bundle` 启用。检查 `conversation.view` 出现 `virtual-desktop`，并确认旧 `shell.overlay` 消失。若需要重启，明确告知用户。

- [ ] **Step 5: Verify packaging**

Run: `npm pack --dry-run`
Expected: 清单包含 `index.js`、`client.js`、`session-runtime.js`、`monitor-protocol.js`、`sidecar/target/release/dshv.exe`、locale、icon、README；不含 `node_modules`、`docs/evidence`、`test`。

- [ ] **Step 6: Publish**

Run: `npm publish --access public`
Expected: 成功；随后 `npm view dsh-vdesktop version` 返回 `0.2.0`。若未登录，先请用户执行 `npm login`；不得尝试窃取或打印 token。

- [ ] **Step 7: Commit verification record**

```bash
git add docs/verification.md
git commit -m "docs: record 0.2.0 verification"
```
