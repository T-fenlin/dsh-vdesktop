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

test('takeover state is reported in the snapshot', () => {
  const { runtimes } = makeRuntimes();
  const a = runtimes.forSession('s1');
  assert.equal(a.snapshot().takeover, false);
  a.beginTakeover();
  assert.equal(a.snapshot().takeover, true);
  a.endTakeover();
  assert.equal(a.snapshot().takeover, false);
});
