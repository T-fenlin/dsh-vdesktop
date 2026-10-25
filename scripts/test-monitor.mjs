/**
 * Local harness that exercises the Host half the way Cordis would:
 * a mock ctx with `tools.register`, a nested `ctx.inject(['webServer'])` that
 * mounts a real node:http server, and two real WebSocket clients — one per
 * session — asserting that each receives only its own journal and frames.
 *
 * Run: node scripts/test-monitor.mjs
 */
import http from 'node:http';
import { WebSocket } from 'ws';
import * as plugin from '../index.js';

const SESSION = 'session-a';
const OTHER = 'session-b';

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
    logger: { info: () => {}, error: (...a) => console.log('[ctx.error]', ...a), warn: () => {} },
    effect: (fn) => {
      const dispose = fn();
      effects.push(dispose);
      return () => {};
    },
    on: () => () => {},
    inject: (names, fn) => {
      if (names.includes('webServer')) {
        const scoped = {
          webServer: {
            registerUpgrade: (route) => {
              server.__upgrades.push(route);
              return () => {
                server.__upgrades = server.__upgrades.filter((r) => r !== route);
              };
            },
          },
          effect: (fn) => {
            const dispose = fn();
            effects.push(dispose);
          },
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

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = server.__upgrades.find((r) => r.path === url.pathname);
  if (!route) {
    socket.destroy();
    return;
  }
  try {
    await route.handler(req, socket, head);
  } catch (e) {
    console.error('[upgrade handler]', e);
    socket.destroy();
  }
});
server.on('clientError', (err, socket) => {
  console.error('[clientError]', err.message);
  socket.destroy();
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

// A tool call is attributed through `exec.agent`; this is the same contract the
// ToolRuntime passes to a definition, so the harness uses it too.
const exec = (sessionId) => ({ agent: { id: sessionId } });
const tool = (name) => ctx.__registered.find((d) => d.name === name);

function connect(sessionId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/vdesk/live?session=${encodeURIComponent(sessionId)}`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  const inbox = [];
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  return { ws, inbox };
}

// ---------------------------------------------------------------- ws client
console.log('\n== websocket ==');
const a = connect(SESSION);
const b = connect(OTHER);
await Promise.all([
  new Promise((res, rej) => {
    a.ws.on('open', res);
    a.ws.on('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 4000);
  }),
  new Promise((res, rej) => {
    b.ws.on('open', res);
    b.ws.on('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 4000);
  }),
]);
check('websocket connected', true);

await new Promise((r) => setTimeout(r, 300));
check('initial snapshot received', a.inbox.some((m) => m.type === 'snapshot'), `${a.inbox.length} messages`);

// ---------------------------------------------------------------- a real call
console.log('\n== driving a desktop ==');
let openResult;
try {
  openResult = await tool('vdesk_open').execute(
    { name: 'monitor-test', exe: 'C:/Windows/System32/notepad.exe', waitMs: 1200 },
    exec(SESSION),
  );
  check('vdesk_open succeeded', openResult.alive === true, `${openResult.windows?.length ?? 0} windows`);
} catch (e) {
  check('vdesk_open succeeded', false, e.message);
}

await new Promise((r) => setTimeout(r, 600));
const journal = a.inbox.filter((m) => m.type === 'journal').pop();
check('journal recorded vdesk_open', journal?.entries?.some((e) => e.tool === 'vdesk_open'), JSON.stringify(journal?.entries?.map((e) => e.tool)));
check('journal entry carries timing', journal?.entries?.[0]?.ms !== undefined, `${journal?.entries?.[0]?.ms}ms`);
check('journal entry carries ok flag', journal?.entries?.[0]?.ok === true);
check('the other session saw no journal entry', (b.inbox.filter((m) => m.type === 'journal').pop()?.entries?.length ?? 0) === 0);

const frames = a.inbox.filter((m) => m.type === 'frame');
check('a frame was pushed', frames.length > 0, `${frames.length} frame(s)`);
if (frames.length) {
  const f = frames[frames.length - 1];
  check('frame names its desktop', f.desktop === 'monitor-test', f.desktop);
  check('frame carries pixels', typeof f.pngBase64 === 'string' && f.pngBase64.length > 1000, `${f.pngBase64.length} b64 chars`);
  check('frame carries dimensions', f.width > 0 && f.height > 0, `${f.width}x${f.height}`);
  check('frame names its reason', typeof f.reason === 'string', f.reason);
}
check('the other session saw no frame', b.inbox.filter((m) => m.type === 'frame').length === 0);

// A failing call must be journaled as ok:false and still not break the socket.
console.log('\n== failure path ==');
try {
  await tool('vdesk_windows').execute({ name: 'no-such-desktop' }, exec(SESSION));
  check('missing desktop rejects', false, 'no throw');
} catch {
  check('missing desktop rejects', true);
}
await new Promise((r) => setTimeout(r, 300));
const logAfterFail = a.inbox.filter((m) => m.type === 'journal').pop();
check('failure journaled', logAfterFail?.entries?.some((e) => e.tool === 'vdesk_windows' && e.ok === false));
check('failure carries message', typeof logAfterFail?.entries?.find((e) => e.ok === false)?.error === 'string');

// A call without a session is rejected rather than silently attributed to someone.
console.log('\n== attribution ==');
try {
  await tool('vdesk_list').execute({}, {});
  check('agentless call rejected', false, 'no throw');
} catch (e) {
  check('agentless call rejected', /会话/.test(e.message), e.message);
}

// Duplicate frames must be suppressed (idle cost = 0).
console.log('\n== frame suppression ==');
const before = a.inbox.filter((m) => m.type === 'frame').length;
await tool('vdesk_shot').execute({ name: 'monitor-test' }, exec(SESSION));
await new Promise((r) => setTimeout(r, 400));
const after = a.inbox.filter((m) => m.type === 'frame').length;
check('no duplicate frame for unchanged window', after === before, `before=${before} after=${after}`);

// A client that connects after the frames must still see the last one.
console.log('\n== late client replay ==');
const late = connect(SESSION);
await new Promise((res, rej) => {
  late.ws.on('open', res);
  late.ws.on('error', rej);
  setTimeout(() => rej(new Error('late ws open timeout')), 4000);
});
await new Promise((r) => setTimeout(r, 400));
const snapshot = late.inbox.find((m) => m.type === 'snapshot');
check('late client receives a snapshot with a frame', Boolean(snapshot?.frame?.pngBase64));
check('snapshot names its desktop', snapshot?.frame?.desktop === 'monitor-test', snapshot?.frame?.desktop);
check('late client still receives the journal', (snapshot?.journal?.length ?? 0) > 0);
late.ws.close();

// Takeover round-trip: takeover, agent blocked, release, agent allowed.
console.log('\n== takeover ==');
a.ws.send(JSON.stringify({ type: 'takeover' }));
await new Promise((r) => setTimeout(r, 200));
try {
  await tool('vdesk_list').execute({}, exec(SESSION));
  check('agent blocked while user has control', false, 'no throw');
} catch (e) {
  check('agent blocked while user has control', /接管/.test(e.message), e.message);
}
check('the other session is unaffected', Array.isArray((await tool('vdesk_list').execute({}, exec(OTHER))).desktops));
a.ws.send(JSON.stringify({ type: 'release' }));
await new Promise((r) => setTimeout(r, 200));
check('agent allowed after release', Array.isArray((await tool('vdesk_list').execute({}, exec(SESSION))).desktops));

// A foreign origin must not be able to open the socket.
console.log('\n== origin ==');
const evil = new WebSocket(`ws://127.0.0.1:${port}/vdesk/live?session=${SESSION}`, {
  headers: { origin: 'https://evil.example' },
});
const closed = await new Promise((res) => {
  evil.on('close', () => res(true));
  evil.on('error', () => res(true));
  setTimeout(() => res(false), 3000);
});
check('foreign origin is refused', closed === true);

// ---------------------------------------------------------------- teardown
console.log('\n== teardown ==');
await tool('vdesk_close').execute({ name: 'monitor-test' }, exec(SESSION));
a.ws.close();
b.ws.close();
for (const e of ctx.__effects) e();
server.close();

console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL CHECKS PASSED'}`);
process.exit(failures.length ? 1 : 0);
