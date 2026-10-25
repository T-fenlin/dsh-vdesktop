import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRuntimes } from '../session-runtime.js';

function makeRuntimes(overrides = {}) {
  const calls = [];
  const created = new Map();
  return {
    calls,
    runtimes: new SessionRuntimes({
      createSidecar: (sessionId) => {
        calls.push({ kind: 'sidecar', sessionId });
        const sidecar = {
          call: async (method, params) => {
            calls.push({ kind: 'call', method, params });
            return { ok: true };
          },
          stop: () => calls.push({ kind: 'stop', sessionId }),
        };
        created.set(sessionId, sidecar);
        return sidecar;
      },
      createBrowser: (sessionId) => {
        calls.push({ kind: 'browser', sessionId });
        return { close: () => calls.push({ kind: 'browser.close', sessionId }) };
      },
      capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
      ...overrides,
    }),
  };
}

test('each session gets its own runtime and desktop name namespace', () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  const b = runtimes.forSession('s2');
  assert.notEqual(a, b);
  assert.equal(a.scopeName('task'), 's1:task');
  assert.equal(b.scopeName('task'), 's2:task');
});

test('takeover blocks agent tools in that session only', async () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  const b = runtimes.forSession('s2');
  a.beginTakeover();
  await assert.rejects(
    () => a.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => ({})),
    /接管/,
  );
  await assert.doesNotReject(() =>
    b.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => ({})),
  );
  a.endTakeover();
  await assert.doesNotReject(() =>
    a.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => ({})),
  );
});

test('disposing a session stops its sidecar and browser and forgets it', () => {
  const { calls, runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  a.browser();
  runtimes.disposeSession('s1');
  assert.ok(calls.some((c) => c.kind === 'stop' && c.sessionId === 's1'));
  assert.ok(calls.some((c) => c.kind === 'browser.close' && c.sessionId === 's1'));
  assert.equal(runtimes.has('s1'), false);
});

test('snapshot never exposes another session journal', async () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  const b = runtimes.forSession('s2');
  await a.runTool('vdesk_list', {}, async () => ({}));
  assert.equal(a.snapshot().journal.length, 1);
  assert.equal(b.snapshot().journal.length, 0);
});

test('UI input is rejected before takeover and translated after it', async () => {
  const { calls, runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  await assert.rejects(
    () => a.applyUiInput({ kind: 'click', desktop: 'task', x: 10, y: 20 }),
    /接管/,
  );
  a.beginTakeover();
  await a.applyUiInput({ kind: 'click', desktop: 'task', x: 10, y: 20 });
  const click = calls.filter((c) => c.kind === 'call' && c.method === 'input.click').at(-1);
  assert.equal(click.params.desktop, 's1:task');
});

test('UI input accepts only known kinds', async () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  a.beginTakeover();
  await assert.rejects(() => a.applyUiInput({ kind: 'rm -rf', desktop: 'task' }), /不支持/);
});

test('agent tool failures are journaled and rethrown', async () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  await assert.rejects(
    () =>
      a.runTool('vdesk_click', { name: 'task', x: 1, y: 2 }, async () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  const entry = a.snapshot().journal.at(-1);
  assert.equal(entry.ok, false);
  assert.match(entry.error, /boom/);
});

test('calls scope desktop identifiers for the sidecar', async () => {
  const { calls, runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  await a.call('desktop.create', { name: 'task', exe: 'notepad.exe' });
  assert.equal(calls.at(-1).params.name, 's1:task');

  await a.call('input.click', { desktop: 'task', x: 1, y: 2 });
  assert.equal(calls.at(-1).params.desktop, 's1:task');
});

test('calls unscope desktop names in returned payloads', async () => {
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({
      call: async () => ({ desktop: 's1:task', desktops: [{ name: 's1:task' }], closed: 's1:task' }),
      stop() {},
    }),
    createBrowser: () => ({ close() {} }),
    capture: async () => ({ pngBase64: 'AAA', width: 10, height: 10 }),
  });
  const a = runtimes.forSession('s1');
  const result = await a.call('desktop.list');
  assert.equal(result.desktop, 'task');
  assert.equal(result.desktops[0].name, 'task');
  assert.equal(result.closed, 'task');
});

test('browser frames are published with a browser target', async () => {
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({ call: async () => ({}), stop() {} }),
    createBrowser: () => ({
      close() {},
      screenshotBase64: async () => ({ pngBase64: 'AAAA', width: 800, height: 600 }),
    }),
    capture: null,
  });
  const runtime = runtimes.forSession('s1');
  runtime.browser();
  const seen = [];
  runtime.subscribe((message) => seen.push(message));
  const frame = await runtime.refreshBrowserFrame('browser_open');
  assert.equal(frame.target, 'browser');
  assert.equal(seen.at(-1).type, 'frame');
  assert.equal(seen.at(-1).target, 'browser');
});

test('closing the browser is idempotent and can be reopened', () => {
  let created = 0;
  const runtimes = new SessionRuntimes({
    createSidecar: () => ({ call: async () => ({}), stop() {} }),
    createBrowser: () => {
      created++;
      return { close() {} };
    },
    capture: null,
  });
  const runtime = runtimes.forSession('s1');
  runtime.browser();
  runtime.closeBrowser();
  runtime.closeBrowser();
  runtime.browser();
  assert.equal(created, 2);
});

test('takeover state is reported in the snapshot', () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  assert.equal(a.snapshot().takeover, false);
  a.beginTakeover();
  assert.equal(a.snapshot().takeover, true);
  a.endTakeover();
  assert.equal(a.snapshot().takeover, false);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('an idle desktop is reclaimed after the timeout', async () => {
  const { runtimes, calls } = makeRuntimes({ idleTimeoutMs: 60 });
  const a = runtimes.forSession('s1');
  await sleep(180);
  assert.equal(runtimes.has('s1'), false, 'runtime should be gone');
  assert.ok(
    calls.some((c) => c.kind === 'stop' && c.sessionId === 's1'),
    'sidecar must be stopped',
  );
  assert.throws(() => a.assertAlive(), /已关闭/);
});

test('activity defers reclamation', async () => {
  const { runtimes } = makeRuntimes({ idleTimeoutMs: 120 });
  const a = runtimes.forSession('s1');
  for (let i = 0; i < 4; i++) {
    await sleep(60);
    a.touch();
  }
  assert.equal(runtimes.has('s1'), true, 'touched runtime must survive');
  await sleep(220);
  assert.equal(runtimes.has('s1'), false, 'then it idles out');
});

test('an attached viewer prevents reclamation', async () => {
  const { runtimes } = makeRuntimes({ idleTimeoutMs: 80 });
  const a = runtimes.forSession('s1');
  const unsubscribe = a.subscribe(() => {});
  await sleep(220);
  assert.equal(runtimes.has('s1'), true, 'a watched desktop must stay alive');
  unsubscribe();
  await sleep(220);
  assert.equal(runtimes.has('s1'), false, 'unwatching lets it idle out');
});

test('takeover prevents reclamation', async () => {
  const { runtimes } = makeRuntimes({ idleTimeoutMs: 80 });
  const a = runtimes.forSession('s1');
  a.beginTakeover();
  await sleep(220);
  assert.equal(runtimes.has('s1'), true, 'a desktop under user control must stay alive');
  a.endTakeover();
  await sleep(220);
  assert.equal(runtimes.has('s1'), false, 'releasing lets it idle out');
});

test('idleTimeoutMs 0 disables reclamation', async () => {
  const { runtimes } = makeRuntimes({ idleTimeoutMs: 0 });
  runtimes.forSession('s1');
  await sleep(200);
  assert.equal(runtimes.has('s1'), true, '0 means never reclaim');
});

test('disposeSession cancels the pending idle timer', async () => {
  const { runtimes } = makeRuntimes({ idleTimeoutMs: 80 });
  runtimes.forSession('s1');
  runtimes.disposeSession('s1');
  await sleep(160);
  // No throw, no double-stop: a disposed runtime's timer must not fire.
  assert.equal(runtimes.has('s1'), false);
});
