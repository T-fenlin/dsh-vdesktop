/**
 * dsh-vdesktop — host half.
 *
 * Spawns the Rust sidecar (`dshv.exe`) and exposes `vdesk_*` tools to the agent. Each
 * tool maps to one JSON-RPC method; the sidecar owns the actual Win32 desktops.
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

export const name = 'dsh-vdesktop';
// `tools` is what the plugin exists for, so it is the only hard requirement.
// `webServer` is reached through a nested ctx.inject below: naming it here would
// keep this fiber PENDING on a composition with no HTTP listener (Electron uses
// file:// plus IPC), which would disable every tool just to lose the monitor.
export const inject = ['tools'];

const here = dirname(fileURLToPath(import.meta.url));

/** Schemastery schema: the Loader validates this row's config against it. */
export const Config = z.object({
  /** Absolute path to dshv.exe; empty means <repo>/sidecar/target/release/dshv.exe. */
  sidecarPath: z.string().default(''),
  callTimeoutMs: z.number().min(1000).default(60000),
  /** Browser executable for the headless CDP tools; empty means Edge. */
  browserExe: z.string().default(''),
  /** DevTools port for the headless browser. */
  browserPort: z.number().min(1024).max(65535).default(9333),
});

/** Resolve dshv.exe: explicit config path, then the repo's release build. */
function resolveSidecar(configured) {
  const candidates = [
    configured,
    join(here, 'sidecar', 'target', 'release', 'dshv.exe'),
    join(here, 'sidecar', 'dshv.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    const p = isAbsolute(c) ? c : join(here, c);
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

/** Save a PNG and return both the path and an image content block. */
function saveShot(result, label) {
  const dir = join(tmpdir(), 'dshv-shots');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${label}-${Date.now()}.png`);
  writeFileSync(path, Buffer.from(result.pngBase64, 'base64'));
  return path;
}

// ------------------------------------------------------------------ live monitor
//
// The Host half owns the sidecar, so it is the only place that can see what the
// agent is doing. Every tool call is journaled here and pushed to the browser
// over one WebSocket; a frame is captured only when something actually changed,
// so an idle desktop costs nothing.

const MAX_LOG = 50;

class Monitor {
  constructor() {
    this.log = [];
    this.sockets = new Set();
    this.wss = null;
    /** name -> last pushed frame signature, to suppress duplicate pushes. */
    this.sent = new Map();
    /** name -> last pushed frame, replayed to a client that connects late. */
    this.lastFrames = new Map();
    // Diagnostics. A frame that never arrives is indistinguishable from a
    // capture that failed or a signature that collided, so every outcome is
    // counted and the last one is kept verbatim.
    this.framesPushed = 0;
    this.framesSuppressed = 0;
    this.captureFailures = 0;
    this.lastCapture = null;
  }

  attach(wss) {
    this.wss = wss;
    wss.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => this.sockets.delete(socket));
      this.send(socket, { type: 'log', entries: this.log });
      // A page opened after the frames were pushed has nothing to show, so the
      // last frame per desktop is replayed alongside the journal snapshot.
      for (const [name, frame] of this.lastFrames) {
        this.send(socket, { type: 'frame', ...frame, desktop: name, replay: true });
      }
    });
  }

  send(socket, message) {
    if (socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* a dead socket is dropped by its close handler */
    }
  }

  broadcast(message) {
    const line = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(line);
      } catch {
        /* ignore */
      }
    }
  }

  record(entry) {
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.broadcast({ type: 'log', entries: this.log });
  }

  /** Push one frame, skipping it when nothing visible changed. */
  pushFrame(name, pngBase64, width, height, reason) {
    const signature = `${width}x${height}:${pngBase64.length}:${pngBase64.slice(-64)}`;
    this.lastCapture = {
      at: Date.now(),
      desktop: name,
      reason,
      width,
      height,
      bytes: pngBase64.length,
      signature,
    };
    if (this.sent.get(name) === signature) {
      this.framesSuppressed++;
      return false;
    }
    this.sent.set(name, signature);
    this.framesPushed++;
    const frame = { pngBase64, width, height, reason };
    this.lastFrames.set(name, frame);
    this.broadcast({ type: 'frame', desktop: name, ...frame });
    return true;
  }
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
    ...config,
  };
  const sidecar = new Sidecar(resolveSidecar(cfg.sidecarPath), cfg.callTimeoutMs ?? 60000);
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('dsh-vdesktop: ctx.tools.register unavailable');
  }

  // ------------------------------------------------------------------ live monitor
  // One WebSocket on the Host web server pushes (a) the tool-call journal and
  // (b) a fresh frame whenever a call changed something on a desktop. Idle
  // desktops push nothing.
  const monitor = new Monitor();
  ctx.inject(['webServer'], (scoped) => {
    const wss = new WebSocketServer({ noServer: true });
    // attach() installs the connection handler that tracks live sockets, so it
    // must run once at setup — not from inside the handler it registers.
    monitor.attach(wss);
    scoped.effect(
      () =>
        scoped.webServer.registerUpgrade({
          path: '/vdesk/live',
          handler: (req, socket) => {
            wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => wss.emit('connection', ws, req));
          },
        }),
      'dsh-vdesktop.ws',
    );
  });

  /** Wrap one tool definition so every call is journaled and pushes a frame. */
  const watch = (def) => ({
    ...def,
    execute: async (p) => {
      const started = Date.now();
      let ok = true;
      let error;
      try {
        const result = await def.execute(p);
        // A frame is worth pushing only when the call named a desktop and the
        // result carries fresh pixels (a screenshot), or the call mutated state.
        const desktop = p?.name ?? p?.desktop;
        if (desktop) {
          try {
            const shot = await sidecar.call('desktop.screenshot', { desktop, maxWidth: 960, maxHeight: 620 });
            if (!shot || typeof shot.pngBase64 !== 'string') {
              monitor.captureFailures++;
              ctx.logger?.warn?.(
                `[dsh-vdesktop] monitor capture returned no pixels for ${desktop}: ${JSON.stringify(shot)?.slice(0, 200)}`,
              );
            } else {
              monitor.pushFrame(desktop, shot.pngBase64, shot.width, shot.height, def.name);
            }
          } catch (e) {
            // A capture failure must never fail the call, but it must be loud:
            // a silent catch here is indistinguishable from "nothing changed".
            monitor.captureFailures++;
            ctx.logger?.warn?.(`[dsh-vdesktop] monitor capture failed for ${desktop}: ${String(e?.message ?? e)}`);
          }
        }
        return result;
      } catch (e) {
        ok = false;
        error = String(e?.message ?? e);
        throw e;
      } finally {
        monitor.record({
          at: Date.now(),
          tool: def.name,
          args: p,
          ok,
          error,
          ms: Date.now() - started,
        });
      }
    },
  });

  const defs = [
    {
      name: 'vdesk_open',
      description:
        'Create an isolated Windows desktop and launch a GUI program inside it. The desktop is invisible to the user: their mouse, keyboard, WeChat and other windows can never appear in its screenshots. Returns the desktop id, process id and the windows that appeared.',
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
      execute: (p) =>
        sidecar.call('desktop.create', {
          name: p.name,
          exe: p.exe,
          args: p.args ?? '',
          waitMs: p.waitMs ?? 900,
        }),
    },
    {
      name: 'vdesk_list',
      description: 'List the virtual desktops this session currently owns.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: jsonOut,
      execute: () => sidecar.call('desktop.list'),
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
      execute: (p) => sidecar.call('desktop.close', { name: p.name }),
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
      execute: (p) => sidecar.call('window.list', { desktop: p.name, all: p.all ?? false }),
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
      execute: async (p) => {
        const r = await sidecar.call('desktop.screenshot', {
          desktop: p.name,
          window: p.window ?? null,
          maxWidth: p.maxWidth ?? 1600,
          maxHeight: p.maxHeight ?? 1000,
        });
        const path = saveShot(r, p.name);
        return { desktop: p.name, path, width: r.width, height: r.height, meta: r.meta };
      },
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
      execute: (p) =>
        sidecar.call('input.click', {
          desktop: p.name,
          x: p.x,
          y: p.y,
          button: p.button ?? 'left',
          count: p.count ?? 1,
          window: p.window ?? null,
          settleMs: p.settleMs ?? 120,
        }),
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
      execute: (p) =>
        sidecar.call('input.drag', {
          desktop: p.name,
          from: p.from,
          to: p.to,
          window: p.window ?? null,
        }),
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
      execute: (p) =>
        sidecar.call('input.scroll', {
          desktop: p.name,
          x: p.x,
          y: p.y,
          dy: p.dy ?? 120,
          window: p.window ?? null,
        }),
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
      execute: (p) =>
        sidecar.call('input.type', { desktop: p.name, text: p.text, window: p.window ?? null }),
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
      execute: (p) =>
        sidecar.call('input.key', { desktop: p.name, keys: p.keys, window: p.window ?? null }),
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
      execute: (p) =>
        sidecar.call('window.text', { desktop: p.name, window: p.window ?? null }),
    },
    {
      name: 'vdesk_monitor',
      description:
        'Inspect the live monitor: how many frames were pushed, suppressed by the signature check, or lost to a capture failure, plus the last capture that was seen. Use this when the browser monitor shows no picture.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: jsonOut,
      execute: () => ({
        sockets: monitor.sockets.size,
        upgradeRegistered: Boolean(monitor.wss),
        framesPushed: monitor.framesPushed,
        framesSuppressed: monitor.framesSuppressed,
        captureFailures: monitor.captureFailures,
        lastCapture: monitor.lastCapture,
        journalLength: monitor.log.length,
      }),
    },
  ];

  for (const d of defs) tools.register(watch(d));

  // ------------------------------------------------------------------ headless browser
  // Chromium renders through DirectComposition, and DWM keeps no surface for windows on a
  // non-input desktop, so a hidden desktop can never screenshot it. A headless browser has
  // no window at all: it renders offscreen and hands frames over CDP. Verified working with
  // the screen locked and the user busy elsewhere.
  let browser = null;
  const getBrowser = () => {
    if (!browser) {
      browser = new HeadlessBrowser({
        exe: cfg.browserExe || undefined,
        port: cfg.browserPort ?? 9333,
      });
    }
    return browser;
  };

  const browserDefs = [
    {
      name: 'browser_open',
      description:
        'Open a URL in a headless Edge/Chrome (CDP). Runs completely offscreen: no window, no desktop, works while the screen is locked. Returns the page title and final URL.',
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
      execute: async (p) => {
        const b = getBrowser();
        const title = await b.goto(p.url, { waitMs: p.waitMs ?? 1500 });
        return { title, url: await b.url() };
      },
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
      execute: async (p) => {
        const b = getBrowser();
        if (p.width && p.height) await b.setViewport(p.width, p.height);
        const shot = await b.screenshot();
        return { path: shot.path, bytes: shot.bytes, width: b.width, height: b.height };
      },
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
      execute: (p) =>
        getBrowser().click({
          selector: p.selector,
          x: p.x,
          y: p.y,
          button: p.button ?? 'left',
          count: p.count ?? 1,
        }),
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
      execute: (p) => getBrowser().type(p.text),
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
      execute: (p) => getBrowser().key(p.keys),
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
      execute: async (p) => ({ value: await getBrowser().evaluate(p.expression) }),
    },
    {
      name: 'browser_close',
      description: 'Close the headless browser and free its process.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: jsonOut,
      execute: () => {
        browser?.close();
        browser = null;
        return { closed: true };
      },
    },
  ];

  for (const d of browserDefs) tools.register(d);

  ctx.on?.('dispose', () => {
    browser?.close();
    sidecar.stop();
  });
  ctx.logger?.info?.(`[dsh-vdesktop] ready, sidecar=${sidecar.exe}`);
}

// NOTE: do NOT add `export default apply`. The Loader's unwrapExports() prefers
// `default`, so a default export replaces the whole namespace and drops the
// `inject` declaration, which makes `ctx.tools` fail with
// "cannot get property "tools" without inject".
