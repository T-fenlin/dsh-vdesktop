import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveSidecar } from '../index.js';

function mockCtx({ withWebServer = false } = {}) {
  const registered = [];
  const effects = [];
  const warnings = [];
  const ctx = {
    tools: { register: (def) => { registered.push(def); return () => {}; } },
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    effect: (fn) => { effects.push(fn); return () => {}; },
    on: () => () => {},
    get: () => undefined,
    inject: (names, fn) => {
      if (withWebServer && names.includes('webServer')) {
        fn({
          webServer: { registerUpgrade: () => () => {} },
          effect: (f) => effects.push(f),
        });
      }
    },
  };
  return { ctx, registered, warnings };
}

test('apply does not throw when the sidecar executable is missing', () => {
  const { ctx, registered } = mockCtx();
  assert.doesNotThrow(() => apply(ctx, { sidecarPath: 'Z:/does-not-exist/dshv.exe' }));
  assert.ok(registered.some((d) => d.name === 'vdesk_open'), 'tools must still register');
});

test('apply does not throw when webServer is absent', () => {
  const { ctx, registered } = mockCtx({ withWebServer: false });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.ok(registered.some((d) => d.name === 'browser_open'));
});

test('resolveSidecar reports a clear error for a missing explicit path', () => {
  assert.throws(
    () => resolveSidecar('Z:/does-not-exist/dshv.exe', 'Z:/also-missing'),
    /dshv\.exe not found/,
  );
});

test('apply registers every tool even without a sidecar or web server', () => {
  const { ctx, registered } = mockCtx();
  apply(ctx, { sidecarPath: 'Z:/does-not-exist/dshv.exe' });
  const names = registered.map((d) => d.name);
  assert.equal(names.length, 19);
  assert.ok(names.includes('vdesk_monitor'));
});
