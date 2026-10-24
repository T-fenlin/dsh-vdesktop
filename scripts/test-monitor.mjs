/**
 * Local harness that exercises the Host half the way Cordis would:
 * a mock ctx with `tools.register`, a nested `ctx.inject(['webServer'])` that
 * mounts a real node:http server, and a real WebSocket client that asserts the
 * journal and the frame both arrive.
 *
 * Run: node scripts/test-monitor.mjs
 */
import http from 'node:http';
import { WebSocket } from 'ws';
import * as plugin from '../index.js';

const failures = [];
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(label);
};

// ---------------------------------------------------------------- mock ctx
function makeCtx(server) {
  const registered = [];
  const effects = [];
  const ctx = {
    tools: { register: (def) => registered.push(def) },
    logger: { info: () => {}, error: (...a) => console.log('[ctx.error]', ...a) },
    effect: (fn) => {
      effects.push(fn);
      return () => {};
    },
    on: () => () => {},
    inject: (names, fn) => {
      if (names.includes('webServer')) {
        const scoped = {
          webServer: {
            registerUpgrade: (route) => server.__upgrades.push(route),
          },
          effect: (fn) => effects.push(fn),
        };
        fn(scoped);
      }
    },
  };
  ctx.__registered = registered;
  ctx.__effects = effects;
  return ctx;
}

// ---------------------------------------------------------------- fake server
const server = http.createServer();
server.__upgrades = [];
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Wire the upgrade route the plugin registers into the real http server.
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = server.__upgrades.find((r) => r.path === url.pathname);
  if (!route) {
    socket.destroy();
    return;
  }
  await route.handler(req, socket, head);
});

// ---------------------------------------------------------------- activate
console.log('\n== activating plugin ==');
const ctx = makeCtx(server);
await plugin.apply(ctx, {});
const names = ctx.__registered.map((d) => d.name);
console.log(`registered ${names.length} tools:`, names.join(', '));
check('19 tools registered (18 + vdesk_monitor)', names.length === 19, `got ${names.length}`);
check('vdesk_open present', names.includes('vdesk_open'));
check('browser_open present', names.includes('browser_open'));
for (const e of ctx.__effects) e();

// ---------------------------------------------------------------- ws client
console.log('\n== websocket ==');
const ws = new WebSocket(`ws://127.0.0.1:${port}/vdesk/live`);
const inbox = [];
// The listener must exist before `open` resolves: the Host sends the journal
// snapshot from inside its connection handler, which can land in the same TCP
// read batch as the 101 response, and `ws` drops frames with no listener yet.
ws.on('message', (raw) => {
  try {
    inbox.push(JSON.parse(String(raw)));
  } catch {
    /* ignore */
  }
});
const opened = new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('ws open timeout')), 4000);
});
await opened;
check('websocket connected', true);

// The monitor sends the journal snapshot on connect.
await new Promise((r) => setTimeout(r, 300));
check('initial log snapshot received', inbox.some((m) => m.type === 'log'), `${inbox.length} messages`);

// ---------------------------------------------------------------- a real call
console.log('\n== driving a desktop ==');
const openTool = ctx.__registered.find((d) => d.name === 'vdesk_open');
const shotTool = ctx.__registered.find((d) => d.name === 'vdesk_shot');

let openResult;
try {
  openResult = await openTool.execute({ name: 'monitor-test', exe: 'C:/Windows/System32/notepad.exe', waitMs: 1200 });
  check('vdesk_open succeeded', openResult.alive === true, JSON.stringify(openResult.windows?.length ?? 0) + ' windows');
} catch (e) {
  check('vdesk_open succeeded', false, e.message);
}

await new Promise((r) => setTimeout(r, 600));
const logAfterOpen = inbox.filter((m) => m.type === 'log').pop();
check('journal recorded vdesk_open', logAfterOpen?.entries?.some((e) => e.tool === 'vdesk_open'), JSON.stringify(logAfterOpen?.entries?.map((e) => e.tool)));
check('journal entry carries timing', logAfterOpen?.entries?.[0]?.ms !== undefined, `${logAfterOpen?.entries?.[0]?.ms}ms`);
check('journal entry carries ok flag', logAfterOpen?.entries?.[0]?.ok === true);

const frames = inbox.filter((m) => m.type === 'frame');
check('a frame was pushed', frames.length > 0, `${frames.length} frame(s)`);
if (frames.length) {
  const f = frames[frames.length - 1];
  check('frame names its desktop', f.desktop === 'monitor-test', f.desktop);
  check('frame carries pixels', typeof f.pngBase64 === 'string' && f.pngBase64.length > 1000, `${f.pngBase64.length} b64 chars`);
  check('frame carries dimensions', f.width > 0 && f.height > 0, `${f.width}x${f.height}`);
  check('frame names its reason', typeof f.reason === 'string', f.reason);
}

// A failing call must be journaled as ok:false and still not break the socket.
console.log('\n== failure path ==');
try {
  await ctx.__registered.find((d) => d.name === 'vdesk_windows').execute({ name: 'no-such-desktop' });
  check('missing desktop rejects', false, 'no throw');
} catch {
  check('missing desktop rejects', true);
}
await new Promise((r) => setTimeout(r, 300));
const logAfterFail = inbox.filter((m) => m.type === 'log').pop();
check('failure journaled', logAfterFail?.entries?.some((e) => e.tool === 'vdesk_windows' && e.ok === false));
check('failure carries message', typeof logAfterFail?.entries?.find((e) => e.ok === false)?.error === 'string');

// Duplicate frames must be suppressed (idle cost = 0).
console.log('\n== frame suppression ==');
const before = inbox.filter((m) => m.type === 'frame').length;
await shotTool.execute({ name: 'monitor-test' });
await new Promise((r) => setTimeout(r, 400));
const after = inbox.filter((m) => m.type === 'frame').length;
// shot itself returns a frame only if pixels changed; a fresh notepad screenshot
// of an unchanged window should be suppressed.
check('no duplicate frame for unchanged window', after === before, `before=${before} after=${after}`);

// A client that connects after the frames must still see the last one.
console.log('\n== late client replay ==');
const ws2 = new WebSocket(`ws://127.0.0.1:${port}/vdesk/live`);
const inbox2 = [];
ws2.on('message', (raw) => {
  try {
    inbox2.push(JSON.parse(String(raw)));
  } catch {
    /* ignore */
  }
});
await new Promise((res, rej) => {
  ws2.on('open', res);
  ws2.on('error', rej);
  setTimeout(() => rej(new Error('ws2 open timeout')), 4000);
});
await new Promise((r) => setTimeout(r, 400));
const replayed = inbox2.filter((m) => m.type === 'frame');
check('late client receives a replayed frame', replayed.length > 0, `${replayed.length} frame(s)`);
if (replayed.length) {
  check('replayed frame carries pixels', replayed[0].pngBase64?.length > 1000, `${replayed[0].pngBase64?.length} b64 chars`);
  check('replayed frame names its desktop', replayed[0].desktop === 'monitor-test', replayed[0].desktop);
}
const replayedLog = inbox2.filter((m) => m.type === 'log');
check('late client still receives the journal snapshot', replayedLog.length > 0);
ws2.close();

// ---------------------------------------------------------------- teardown
console.log('\n== teardown ==');
await ctx.__registered.find((d) => d.name === 'vdesk_close').execute({ name: 'monitor-test' });
ws.close();
server.close();

console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL CHECKS PASSED'}`);
process.exit(failures.length ? 1 : 0);
