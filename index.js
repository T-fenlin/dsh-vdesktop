/**
 * dsh-vdesktop — host half.
 *
 * Spawns one Rust sidecar (`dshv.exe`) per session and exposes `vdesk_*` /
 * `browser_*` tools to the agent. Every tool call is attributed to the calling
 * Session, so two chats never share a desktop, a browser, a journal, or a
 * takeover lock.
 *
 * The browser-facing half lives in `client.js`; the WebSocket carries only that
 * session's data and also accepts the user's explicit takeover input, so no
 * second unauthenticated control endpoint is introduced.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { WebSocketServer } from 'ws';
import { HeadlessBrowser } from './browser.js';
import { SessionRuntimes } from './session-runtime.js';
import { sessionFromUpgradeUrl, isSameOriginUpgrade } from './monitor-protocol.js';

export const name = 'dsh-vdesktop';
// `tools` is what the plugin exists for, so it is the only hard requirement.
// `agents` and `webServer` are optional: naming them here would keep the fiber
// pending in a composition without them and disable every tool.
export const inject = ['tools'];

const here = dirname(fileURLToPath(import.meta.url));

/** Schemastery schema: the Loader validates this row's config against it. */
export const Config = z.object({
  /** Absolute path to dshv.exe; empty means <repo>/sidecar/target/release/dshv.exe. */
  sidecarPath: z.string().default(''),
  callTimeoutMs: z.number().min(1000).default(60000),
  /** Browser executable for the headless CDP tools; empty means Edge. */
  browserExe: z.string().default(''),
  /** First DevTools port; later sessions in the same Host take the next free one. */
  browserPort: z.number().min(1024).max(65535).default(9333),
  /**
   * Close a session's virtual desktop (sidecar + every GUI it launched) after
   * this many milliseconds with no tool call, takeover or attached viewer.
   * 0 disables reclamation. Defaults to 10 minutes: a forgotten desktop is a
   * leaked process tree, and the sidecar alone is ~5 MB before any GUI.
   */
  idleTimeoutMs: z.number().min(0).default(600000),
});

/** Resolve dshv.exe: explicit config path, then the packaged release build. */
export function resolveSidecar(configured, baseDir = here) {
  const candidates = [
    configured,
    join(baseDir, 'sidecar', 'target', 'release', 'dshv.exe'),
    join(baseDir, 'sidecar', 'dshv.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : join(baseDir, c);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `dsh-vdesktop: dshv.exe not found (looked in: ${candidates.join(', ')}). ` +
      `Build it with: cd sidecar && cargo build --release`,
  );
}

class Sidecar {
  constructor(exe, timeoutMs) {
    this.exe = exe;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.once('error', reject);
      proc.once('spawn', resolve);
      proc.once('exit', (code, signal) => {
        this.proc = null;
        this.ready = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`dshv exited (code=${code} signal=${signal})`));
        }
        this.pending.clear();
      });
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      });
      proc.stderr.on('data', (b) => {
        const s = String(b).trim();
        if (s) console.error('[dsh-vdesktop]', s);
      });
    });
    return this.ready;
  }

  async call(method, params = {}) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dshv call timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  stop() {
    try {
      this.proc?.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.ready = null;
  }
}

/** Save a PNG and return its path. */
function saveShot(result, label) {
  const dir = join(tmpdir(), 'dshv-shots');
  mkdirSync(dir, { recursive: true });
  const safe = String(label).replace(/[^\w.-]+/g, '_');
  const path = join(dir, `${safe}-${Date.now()}.png`);
  writeFileSync(path, Buffer.from(result.pngBase64, 'base64'));
  return path;
}

const jsonOut = {
  schema: { type: 'object' },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  },
};

const shotOut = {
  schema: { type: 'object' },
  render(_args, value) {
    const blocks = [
      {
        type: 'text',
        text: `virtual desktop ${value.desktop}: ${value.width}x${value.height} → ${value.path}`,
      },
    ];
    return blocks;
  },
};

export function apply(ctx, config = {}) {
  // `Config` is the Loader's schema, not a defaults object; spreading it here would put
  // {type, default} descriptors into cfg.
  const cfg = {
    sidecarPath: '',
    callTimeoutMs: 60000,
    browserExe: '',
    browserPort: 9333,
    idleTimeoutMs: 600000,
    ...config,
  };
  // Resolve lazily: a missing or not-yet-mounted sidecar must surface as a tool
  // error, never as a plugin activation failure. On the desktop build this file
  // can load before a linked workspace is ready, and a synchronous throw here
  // turns into "web boot: 1 entry did not activate" and blocks the whole app.
  let resolvedExe = null;
  const sidecarExe = () => {
    if (!resolvedExe) resolvedExe = resolveSidecar(cfg.sidecarPath);
    return resolvedExe;
  };
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('dsh-vdesktop: ctx.tools.register unavailable');
  }

  let browserPort = cfg.browserPort ?? 9333;
  const runtimes = new SessionRuntimes({
    logger: ctx.logger,
    idleTimeoutMs: cfg.idleTimeoutMs ?? 600000,
    createSidecar: () => new Sidecar(sidecarExe(), cfg.callTimeoutMs ?? 60000),
    createBrowser: () => {
      const port = browserPort;
      browserPort = browserPort >= 65535 ? 9333 : browserPort + 1;
      return new HeadlessBrowser({
        exe: cfg.browserExe || undefined,
        port,
      });
    },
    capture: null,
  });

  /** Resolve the calling Session. `exec.agent` is the exact caller. */
  const runtimeFor = (exec) => {
    const id = exec?.agent?.id;
    if (!id) throw new Error('dsh-vdesktop: 该工具需要在会话中调用');
    return runtimes.forSession(id);
  };

  /** One tool body: attribute to the session, journal it, refresh the frame. */
  const run = (exec, name, args, call) => {
    const runtime = runtimeFor(exec);
    const desktop = args?.name ?? args?.desktop;
    return runtime.runTool(name, args, async () => {
      const result = await call(runtime);
      if (name.startsWith('browser_') && name !== 'browser_close') {
        await runtime.refreshBrowserFrame(name);
      } else if (desktop) {
        await runtime.refreshFrame(name, desktop);
      }
      return result;
    });
  };

  const defs = [
    {
      name: 'vdesk_open',
      description:
        'Create an isolated Windows desktop and launch a GUI program inside it. The desktop is invisible to the user: their mouse, keyboard, WeChat and other windows can never appear in its screenshots. Each conversation owns its own desktops.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Desktop id, e.g. "task-1". Reuse it for follow-up calls.' },
          exe: { type: 'string', description: 'Full path to the executable.' },
          args: { type: 'string', description: 'Optional command line arguments as one string.' },
          waitMs: { type: 'number', description: 'How long to wait for the first window (default 900).' },
        },
        required: ['name', 'exe'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_open', p, (runtime) =>
          runtime.call('desktop.create', {
            name: p.name,
            exe: p.exe,
            args: p.args ?? '',
            waitMs: p.waitMs ?? 900,
          }),
        ),
    },
    {
      name: 'vdesk_list',
      description: 'List the virtual desktops this conversation currently owns.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: jsonOut,
      execute: (_p, exec) =>
        run(exec, 'vdesk_list', {}, (runtime) => runtime.call('desktop.list')),
    },
    {
      name: 'vdesk_close',
      description: 'Close a virtual desktop and terminate every process launched into it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_close', p, (runtime) => runtime.call('desktop.close', { name: p.name })),
    },
    {
      name: 'vdesk_windows',
      description: 'List the top-level windows of a virtual desktop (title, class, pid, rect).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          all: { type: 'boolean', description: 'Include hidden/system windows.' },
        },
        required: ['name'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_windows', p, (runtime) =>
          runtime.call('window.list', { desktop: p.name, all: p.all ?? false }),
        ),
    },
    {
      name: 'vdesk_shot',
      description:
        'Screenshot a virtual desktop (or one window) to a PNG file. Captured with PrintWindow per window, so it never shows the user\'s own screen and keeps working while the screen is locked. Returns the file path plus frame size.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          window: {
            type: 'object',
            additionalProperties: true,
            properties: {
              hwnd: { type: 'string' },
              title: { type: 'string' },
              class: { type: 'string' },
              pid: { type: 'number' },
            },
            description: 'Optional window selector; omit for the whole desktop.',
          },
          maxWidth: { type: 'number' },
          maxHeight: { type: 'number' },
        },
        required: ['name'],
      },
      output: shotOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_shot', p, async (runtime) => {
          const r = await runtime.call('desktop.screenshot', {
            desktop: p.name,
            window: p.window ?? null,
            maxWidth: p.maxWidth ?? 1600,
            maxHeight: p.maxHeight ?? 1000,
          });
          const path = saveShot(r, p.name);
          return { desktop: p.name, path, width: r.width, height: r.height, meta: r.meta };
        }),
    },
    {
      name: 'vdesk_click',
      description:
        'Click inside a virtual desktop window using client coordinates. Targets the deepest child window (required for Chromium pages), so it behaves like a real click without touching the user\'s mouse.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          count: { type: 'number', description: '2 for a double click.' },
          window: { type: 'object', additionalProperties: true, properties: {} },
          settleMs: { type: 'number' },
        },
        required: ['name', 'x', 'y'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_click', p, (runtime) =>
          runtime.call('input.click', {
            desktop: p.name,
            x: p.x,
            y: p.y,
            button: p.button ?? 'left',
            count: p.count ?? 1,
            window: p.window ?? null,
            settleMs: p.settleMs ?? 120,
          }),
        ),
    },
    {
      name: 'vdesk_drag',
      description: 'Press, move and release inside a virtual desktop window (client coordinates).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          from: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          to: {
            type: 'object',
            additionalProperties: false,
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          window: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['name', 'from', 'to'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_drag', p, (runtime) =>
          runtime.call('input.drag', {
            desktop: p.name,
            from: p.from,
            to: p.to,
            window: p.window ?? null,
          }),
        ),
    },
    {
      name: 'vdesk_scroll',
      description: 'Scroll the window under a client point of a virtual desktop.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          dy: { type: 'number', description: 'Positive scrolls down, negative scrolls up.' },
          window: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['name', 'x', 'y'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_scroll', p, (runtime) =>
          runtime.call('input.scroll', {
            desktop: p.name,
            x: p.x,
            y: p.y,
            dy: p.dy ?? 120,
            window: p.window ?? null,
          }),
        ),
    },
    {
      name: 'vdesk_type',
      description:
        'Type text into the focused editor of a virtual desktop. Goes through WM_CHAR, so it works without a real keyboard focus and supports Chinese and emoji.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          text: { type: 'string' },
          window: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['name', 'text'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_type', p, (runtime) =>
          runtime.call('input.type', { desktop: p.name, text: p.text, window: p.window ?? null }),
        ),
    },
    {
      name: 'vdesk_key',
      description:
        'Press keys or key combos in a virtual desktop, e.g. ["enter"], ["ctrl+a"], ["alt+f4"]. Modifier state is injected into the target thread, so Ctrl/Shift/Alt are visible to the app.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } },
          window: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['name', 'keys'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_key', p, (runtime) =>
          runtime.call('input.key', { desktop: p.name, keys: p.keys, window: p.window ?? null }),
        ),
    },
    {
      name: 'vdesk_read_text',
      description: 'Read the text content of a virtual desktop window (prefers the editor control).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          window: { type: 'object', additionalProperties: true, properties: {} },
        },
        required: ['name'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'vdesk_read_text', p, (runtime) =>
          runtime.call('window.text', { desktop: p.name, window: p.window ?? null }),
        ),
    },
    {
      name: 'vdesk_monitor',
      description:
        'Inspect this conversation\'s live monitor: whether the user is taking over, the last frame, and the journal. Use this when the view shows no picture.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: jsonOut,
      execute: (_p, exec) => runtimeFor(exec).snapshot(),
    },
  ];

  for (const d of defs) tools.register(d);

  // ------------------------------------------------------------------ headless browser
  // Chromium renders through DirectComposition, and DWM keeps no surface for windows on a
  // non-input desktop, so a hidden desktop can never screenshot it. A headless browser has
  // no window at all: it renders offscreen and hands frames over CDP.
  const browserDefs = [
    {
      name: 'browser_open',
      description:
        'Open a URL in this conversation\'s headless Edge/Chrome (CDP). Runs completely offscreen: no window, no desktop, works while the screen is locked. Returns the page title and final URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          waitMs: { type: 'number', description: 'Extra settle time after load (default 1500).' },
        },
        required: ['url'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'browser_open', p, async (runtime) => {
          const title = await runtime.browser().goto(p.url, { waitMs: p.waitMs ?? 1500 });
          return { title, url: await runtime.browser().url() };
        }),
    },
    {
      name: 'browser_shot',
      description:
        'Screenshot the headless page to a PNG file. Pixels come from the browser compositor over CDP, so they are unaffected by the user\'s windows, other desktops, or a locked screen.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
      output: shotOut,
      execute: (p, exec) =>
        run(exec, 'browser_shot', p, async (runtime) => {
          const browser = runtime.browser();
          if (p.width && p.height) await browser.setViewport(p.width, p.height);
          const shot = await browser.screenshot();
          return { path: shot.path, bytes: shot.bytes, width: browser.width, height: browser.height };
        }),
    },
    {
      name: 'browser_click',
      description: 'Click inside the headless page, by CSS selector or by viewport coordinates.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          count: { type: 'number' },
        },
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'browser_click', p, (runtime) =>
          runtime.browser().click({
            selector: p.selector,
            x: p.x,
            y: p.y,
            button: p.button ?? 'left',
            count: p.count ?? 1,
          }),
        ),
    },
    {
      name: 'browser_type',
      description: 'Type text into the focused element of the headless page (supports CJK).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      output: jsonOut,
      execute: (p, exec) => run(exec, 'browser_type', p, (runtime) => runtime.browser().type(p.text)),
    },
    {
      name: 'browser_key',
      description: 'Press keys or combos in the headless page, e.g. ["Enter"], ["ctrl+a"].',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { keys: { type: 'array', items: { type: 'string' } } },
        required: ['keys'],
      },
      output: jsonOut,
      execute: (p, exec) => run(exec, 'browser_key', p, (runtime) => runtime.browser().key(p.keys)),
    },
    {
      name: 'browser_eval',
      description: 'Evaluate JavaScript in the headless page and return its JSON value.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      output: jsonOut,
      execute: (p, exec) =>
        run(exec, 'browser_eval', p, async (runtime) => ({
          value: await runtime.browser().evaluate(p.expression),
        })),
    },
    {
      name: 'browser_close',
      description: 'Close this conversation\'s headless browser and free its process.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: jsonOut,
      execute: (_p, exec) =>
        run(exec, 'browser_close', {}, (runtime) => {
          runtime.closeBrowser();
          return { closed: true };
        }),
    },
  ];

  for (const d of browserDefs) tools.register(d);

  // ------------------------------------------------------------------ live monitor
  // One WebSocket per page, addressed by `?session=`. It carries this session's
  // snapshot, journal and frames, and accepts the user's explicit takeover input.
  //
  // The monitor is optional infrastructure: on a composition whose web server has
  // no upgrade support (the desktop shell differs from the web bundle) the tools
  // must still work. Every step here is guarded so a missing capability degrades
  // to "no live view", never to "plugin failed to activate".
  const setupMonitor = (webServer) => {
    if (!webServer || typeof webServer.registerUpgrade !== 'function') {
      ctx.logger?.warn?.('[dsh-vdesktop] web server has no upgrade support; live view disabled');
      return;
    }
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket, req) => {
      const sessionId = sessionFromUpgradeUrl(req.url);
      if (!isSameOriginUpgrade(req) || !sessionId) {
        socket.close(1008, 'not allowed');
        return;
      }
      let runtime;
      try {
        runtime = runtimes.forSession(sessionId);
      } catch (e) {
        socket.close(1011, String(e?.message ?? e));
        return;
      }
      const send = (message) => {
        if (socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify(message));
        } catch {
          /* a dead socket is dropped by close */
        }
      };
      send({ type: 'snapshot', ...runtime.snapshot() });
      const unsubscribe = runtime.subscribe(send);
      socket.on('close', unsubscribe);
      socket.on('error', unsubscribe);
      socket.on('message', async (raw) => {
        let message;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (message.type === 'takeover') {
          runtime.beginTakeover();
          send({ type: 'state', takeover: true });
          return;
        }
        if (message.type === 'release') {
          runtime.endTakeover();
          send({ type: 'state', takeover: false });
          return;
        }
        if (message.type === 'close') {
          // The user asked to shut this session's desktop down. Only its own
          // socket can reach this runtime, so no cross-session reach is possible.
          try {
            send({ type: 'closing' });
            runtimes.disposeSession(sessionId);
          } catch (e) {
            send({ type: 'input-error', id: message.id, error: String(e?.message ?? e) });
          }
          return;
        }
        if (message.type === 'input') {
          try {
            await runtime.applyUiInput(message.payload);
            send({ type: 'input-ack', id: message.id });
          } catch (e) {
            send({ type: 'input-error', id: message.id, error: String(e?.message ?? e) });
          }
        }
      });
    });
    ctx.effect(
      () =>
        webServer.registerUpgrade({
          path: '/vdesk/live',
          handler: (req, socket) => {
            wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => wss.emit('connection', ws, req));
          },
        }),
      'dsh-vdesktop.ws',
    );
    ctx.effect(() => () => wss.close(), 'dsh-vdesktop.ws-close');
  };

  // Prefer the service when it is already present; otherwise wait for it without
  // blocking this fiber. `ctx.inject` alone keeps the plugin pending forever on a
  // composition that never mounts a web server, which the desktop shell reports
  // as an activation failure.
  const existingWebServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (existingWebServer) {
    setupMonitor(existingWebServer);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      setupMonitor(scoped.webServer);
    });
  } else {
    ctx.logger?.warn?.('[dsh-vdesktop] no web server; live view disabled');
  }

  // Release everything when an agent goes away; a stale sidecar would otherwise
  // keep desktops and processes alive with no owner.
  if (typeof ctx.on === 'function') {
    ctx.on('agent/disposed', ({ agent }) => {
      try {
        runtimes.disposeSession(agent?.id);
      } catch {
        /* ignore */
      }
    });
  }

  ctx.effect(() => () => runtimes.disposeAll(), 'dsh-vdesktop.runtimes');
  ctx.logger?.info?.(`[dsh-vdesktop] ready, sidecar=${cfg.sidecarPath || '(auto)'}`);
}

// NOTE: do NOT add `export default apply`. The Loader's unwrapExports() prefers
// `default`, so a default export replaces the whole namespace and drops the
// `inject` declaration, which makes `ctx.tools` fail with
// "cannot get property "tools" without inject".
