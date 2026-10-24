/**
 * Headless browser support over the Chrome DevTools Protocol.
 *
 * Why this exists: Chromium-family programs render through DirectComposition, and DWM keeps
 * no surface for windows on a non-input desktop (verified: `DwmGetDxSharedSurface` returns
 * false for every hidden-desktop window). So a hidden desktop cannot screenshot them.
 * A headless browser never creates a window at all — it renders offscreen and hands pixels
 * over CDP, which keeps working while the screen is locked and while the user works.
 *
 * No Playwright/Puppeteer dependency: Node 22 ships `fetch` and `WebSocket`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.events = new Map();
    this.closed = false;
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`cdp socket error: ${e?.message ?? e}`)), {
        once: true,
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      const waiters = this.events.get(msg.method);
      if (waiters?.length) {
        const w = waiters.shift();
        w(msg.params);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('cdp socket closed'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (!this.ws || this.closed) return Promise.reject(new Error('cdp not connected'));
    const id = ++this.seq;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp event ${method} timed out`)), timeoutMs);
      const list = this.events.get(method) ?? [];
      list.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      this.events.set(method, list);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export class HeadlessBrowser {
  constructor({ exe = DEFAULT_EDGE, port = 9333, width = 1280, height = 800, userDataDir } = {}) {
    this.exe = exe;
    this.port = port;
    this.width = width;
    this.height = height;
    this.userDataDir = userDataDir ?? mkdtempSync(join(tmpdir(), 'dshv-browser-'));
    this.proc = null;
    this.cdp = null;
    this.shotDir = join(tmpdir(), 'dshv-browser-shots');
    mkdirSync(this.shotDir, { recursive: true });
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(
      this.exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.userDataDir}`,
        `--window-size=${this.width},${this.height}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    this.proc.stderr.on('data', () => {
      /* chromium is chatty; keep the host log clean */
    });
    await this.waitForVersion();
    const target = await this.findPageTarget();
    this.cdp = new Cdp(target.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async waitForVersion(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.base}/json/version`);
        if (res.ok) return await res.json();
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`headless browser did not start: ${lastErr?.message ?? 'timeout'}`);
  }

  async findPageTarget() {
    const res = await fetch(`${this.base}/json/list`);
    const list = await res.json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target in headless browser');
    return page;
  }

  async goto(url, { waitMs = 1500 } = {}) {
    await this.start();
    const loaded = this.cdp.once('Page.loadEventFired', 15000).catch(() => null);
    await this.cdp.send('Page.navigate', { url });
    await loaded;
    await new Promise((r) => setTimeout(r, waitMs));
    return this.title();
  }

  async title() {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    return r.result?.value ?? '';
  }

  async url() {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    return r.result?.value ?? '';
  }

  async screenshot(path) {
    await this.start();
    const { data } = await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const buffer = Buffer.from(data, 'base64');
    const file = path ?? join(this.shotDir, `shot-${Date.now()}.png`);
    writeFileSync(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  /** Click by CSS selector (centre of the element) or by viewport coordinates. */
  async click({ selector, x, y, button = 'left', count = 1 }) {
    await this.start();
    let px = x;
    let py = y;
    if (selector) {
      const r = await this.cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        })()`,
        returnByValue: true,
      });
      const box = r.result?.value;
      if (!box) throw new Error(`selector not found: ${selector}`);
      px = box.x;
      py = box.y;
    }
    if (typeof px !== 'number' || typeof py !== 'number') {
      throw new Error('click needs either selector or x/y');
    }
    for (let i = 0; i < count; i++) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: px,
        y: py,
        button,
        clickCount: i + 1,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: px,
        y: py,
        button,
        clickCount: i + 1,
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    return { x: px, y: py, button, count };
  }

  async type(text) {
    await this.start();
    await this.cdp.send('Input.insertText', { text });
    return { chars: text.length };
  }

  async key(keys) {
    await this.start();
    const list = Array.isArray(keys) ? keys : [keys];
    for (const combo of list) {
      const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
      const key = parts.pop();
      const modifiers = parts.reduce((acc, m) => {
        const map = { alt: 1, ctrl: 2, control: 2, meta: 4, shift: 8 };
        return acc | (map[m.toLowerCase()] ?? 0);
      }, 0);
      const vk = virtualKey(key);
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: vk,
        modifiers,
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: vk,
        modifiers,
      });
    }
    return { keys: list };
  }

  async evaluate(expression) {
    await this.start();
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text ?? 'evaluate failed');
    }
    return r.result?.value;
  }

  async setViewport(width, height) {
    await this.start();
    this.width = width;
    this.height = height;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { width, height };
  }

  close() {
    this.cdp?.close();
    this.cdp = null;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

function virtualKey(key) {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  const named = {
    Enter: 13,
    Return: 13,
    Tab: 9,
    Escape: 27,
    Esc: 27,
    Backspace: 8,
    Delete: 46,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  return named[key] ?? named[key[0]?.toUpperCase() + key.slice(1)] ?? 0;
}
