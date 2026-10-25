/**
 * Per-session virtual desktop runtimes.
 *
 * The old monitor was global: one journal, one frame, one sidecar for every
 * session. That made two sessions that work at the same time overwrite each
 * other's picture and let the user watch one session while the agent drove
 * another. This module makes the session the ownership boundary:
 *
 *   SessionRuntimes
 *     └─ SessionRuntime (one per SessionId)
 *          ├─ sidecar       (dshv.exe process, owns that session's desktops)
 *          ├─ browser       (headless CDP instance, created on first use)
 *          ├─ journal       (bounded tool-call history)
 *          ├─ frame         (last rendered PNG)
 *          └─ takeover      (user holds the mouse/keyboard)
 *
 * Everything is created lazily, so opening a tab or a new chat costs nothing
 * until the agent actually drives a GUI.
 */
import { frameSignature, normalizeJournalEntry } from './monitor-protocol.js';

const MAX_JOURNAL = 50;
const TAKEOVER_ERROR = '该会话正在被用户接管，请先交还 Agent';
const UNSUPPORTED_INPUT = '不支持的操作';

export class SessionRuntimes {
  constructor({ createSidecar, createBrowser, capture, logger, idleTimeoutMs = 0 } = {}) {
    if (typeof createSidecar !== 'function') throw new Error('SessionRuntimes needs createSidecar');
    if (typeof createBrowser !== 'function') throw new Error('SessionRuntimes needs createBrowser');
    this.createSidecar = createSidecar;
    this.createBrowser = createBrowser;
    this.capture = capture;
    this.logger = logger;
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessions = new Map();
  }

  forSession(sessionId) {
    if (!sessionId) throw new Error('虚拟桌面需要一个会话');
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      runtime = new SessionRuntime(sessionId, {
        sidecar: this.createSidecar(sessionId),
        createBrowser: () => this.createBrowser(sessionId),
        capture: this.capture,
        logger: this.logger,
        idleTimeoutMs: this.idleTimeoutMs,
        onIdleClose: (id) => this.disposeSession(id),
      });
      this.sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  list() {
    return [...this.sessions.keys()];
  }

  disposeSession(sessionId) {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    this.sessions.delete(sessionId);
    runtime.dispose();
  }

  disposeAll() {
    for (const id of [...this.sessions.keys()]) this.disposeSession(id);
  }
}

export class SessionRuntime {
  constructor(sessionId, { sidecar, createBrowser, capture, logger, idleTimeoutMs = 0, onIdleClose }) {
    this.sessionId = sessionId;
    this.sidecar = sidecar;
    this.createBrowser = createBrowser;
    this.capture = capture;
    this.logger = logger;
    this.journal = [];
    this.frame = null;
    this.takeover = false;
    this.disposed = false;
    this._browser = null;
    this._frameSig = null;
    this._subscribers = new Set();
    // Idle reclamation. A desktop nobody operates or watches is a leaked
    // process tree: the sidecar alone is ~5 MB and any GUI it launched is far
    // more. 0 disables reclamation entirely.
    this.idleTimeoutMs = idleTimeoutMs;
    this.onIdleClose = onIdleClose;
    this.lastActivityAt = Date.now();
    this._idleTimer = null;
    this._armIdleTimer();
  }

  /** Note that something happened; a live desktop must not be reclaimed mid-use. */
  touch() {
    this.lastActivityAt = Date.now();
  }

  /**
   * While a page is subscribed the user may be watching the frame, so idling
   * out would yank the picture away under them. Re-arm on the next unsubscribe.
   */
  _armIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (!(this.idleTimeoutMs > 0) || this.disposed) return;
    this._idleTimer = setTimeout(() => this._checkIdle(), this.idleTimeoutMs);
    // A pending reclamation must never hold the process open on its own.
    this._idleTimer.unref?.();
  }

  _checkIdle() {
    this._idleTimer = null;
    if (this.disposed) return;
    if (this._subscribers.size > 0 || this.takeover) {
      this._armIdleTimer();
      return;
    }
    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor < this.idleTimeoutMs) {
      this._idleTimer = setTimeout(() => this._checkIdle(), this.idleTimeoutMs - idleFor);
      this._idleTimer.unref?.();
      return;
    }
    this.logger?.info?.(
      `[dsh-vdesktop] closing idle virtual desktop for session ${this.sessionId} (idle ${Math.round(idleFor / 1000)}s)`,
    );
    try {
      this.onIdleClose?.(this.sessionId);
    } catch (e) {
      this.logger?.warn?.(`[dsh-vdesktop] idle close failed: ${String(e?.message ?? e)}`);
    }
  }

  assertAlive() {
    if (this.disposed) throw new Error('虚拟桌面已关闭，请重新调用工具');
  }

  /** Turn a sidecar desktop name back into the name the agent supplied. */
  unscopeName(name) {
    const prefix = `${this.sessionId}:`;
    return typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }

  /**
   * One RPC through this session's sidecar. Desktop identifiers are translated
   * here, so tool definitions and the UI can keep using the logical name while
   * the sidecar sees a globally unique one.
   */
  async call(method, params = {}) {
    this.assertAlive();
    const next = { ...params };
    if (typeof next.desktop === 'string') next.desktop = this.scopeName(next.desktop);
    if (method === 'desktop.create' || method === 'desktop.close') {
      if (typeof next.name === 'string') next.name = this.scopeName(next.name);
    }
    const result = await this.sidecar.call(method, next);
    if (result && typeof result === 'object') {
      if (typeof result.desktop === 'string') result.desktop = this.unscopeName(result.desktop);
      if (Array.isArray(result.desktops)) {
        result.desktops = result.desktops.map((desktop) =>
          desktop && typeof desktop.name === 'string'
            ? { ...desktop, name: this.unscopeName(desktop.name) }
            : desktop,
        );
      }
      if (typeof result.closed === 'string') result.closed = this.unscopeName(result.closed);
    }
    return result;
  }

  /** Map a logical desktop name into this session's own namespace. */
  scopeName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('缺少桌面名称');
    if (/\s/.test(name)) throw new Error('桌面名称不能包含空白');
    return `${this.sessionId}:${name}`;
  }

  browser() {
    this.assertAlive();
    if (!this._browser) this._browser = this.createBrowser();
    return this._browser;
  }

  closeBrowser() {
    try {
      this._browser?.close();
    } catch {
      /* ignore */
    }
    this._browser = null;
  }

  subscribe(listener) {
    this._subscribers.add(listener);
    this.touch();
    this._armIdleTimer();
    return () => {
      this._subscribers.delete(listener);
      this.touch();
      // The watcher just left; start counting idle time from now.
      this._armIdleTimer();
    };
  }

  publish(message) {
    const envelope = { ...message, sessionId: this.sessionId };
    for (const listener of this._subscribers) {
      try {
        listener(envelope);
      } catch (e) {
        this.logger?.warn?.(`[dsh-vdesktop] monitor subscriber failed: ${String(e?.message ?? e)}`);
      }
    }
  }

  snapshot() {
    this.assertAlive();
    return {
      sessionId: this.sessionId,
      takeover: this.takeover,
      frame: this.frame,
      journal: this.journal,
    };
  }

  beginTakeover() {
    this.assertAlive();
    this.takeover = true;
    this.touch();
    this._armIdleTimer();
    this.publish({ type: 'state', takeover: true });
  }

  endTakeover() {
    this.takeover = false;
    this.touch();
    this._armIdleTimer();
    this.publish({ type: 'state', takeover: false });
  }

  record(entry) {
    const normalized = normalizeJournalEntry(entry);
    this.journal.push(normalized);
    if (this.journal.length > MAX_JOURNAL) this.journal.splice(0, this.journal.length - MAX_JOURNAL);
    this.publish({ type: 'journal', entries: this.journal });
    return normalized;
  }

  async runTool(name, args, execute) {
    this.assertAlive();
    if (this.takeover) throw new Error(TAKEOVER_ERROR);
    this.touch();
    const started = Date.now();
    try {
      const result = await execute();
      this.record({ at: started, tool: name, args, ok: true, ms: Date.now() - started });
      return result;
    } catch (e) {
      this.record({
        at: started,
        tool: name,
        args,
        ok: false,
        error: String(e?.message ?? e),
        ms: Date.now() - started,
      });
      throw e;
    }
  }

  /** Publish a browser page frame so the tab can show web tasks too. */
  async refreshBrowserFrame(reason) {
    if (!this._browser) return null;
    try {
      const shot = await this._browser.screenshotBase64();
      if (!shot?.pngBase64) return null;
      const signature = `browser:${frameSignature(shot)}`;
      if (signature === this._frameSig) return null;
      this._frameSig = signature;
      this.frame = {
        pngBase64: shot.pngBase64,
        width: shot.width,
        height: shot.height,
        desktop: 'browser',
        target: 'browser',
        reason,
        at: Date.now(),
      };
      this.publish({ type: 'frame', ...this.frame });
      return this.frame;
    } catch (e) {
      this.logger?.warn?.(`[dsh-vdesktop] browser frame failed: ${String(e?.message ?? e)}`);
      return null;
    }
  }

  /** Capture after a mutation; a failed capture must never fail the call. */
  async refreshFrame(reason, desktop) {
    if (!desktop) return null;
    try {
      const shot = this.capture
        ? await this.capture(this.scopeName(desktop))
        : await this.sidecar.call('desktop.screenshot', {
            desktop: this.scopeName(desktop),
            maxWidth: 1440,
            maxHeight: 960,
          });
      if (!shot?.pngBase64) return null;
      const signature = frameSignature(shot);
      if (signature === this._frameSig) return null;
      this._frameSig = signature;
      this.frame = {
        pngBase64: shot.pngBase64,
        width: shot.width,
        height: shot.height,
        desktop,
        target: 'desktop',
        reason,
        at: Date.now(),
      };
      this.publish({ type: 'frame', ...this.frame });
      return this.frame;
    } catch (e) {
      this.logger?.warn?.(`[dsh-vdesktop] monitor capture failed: ${String(e?.message ?? e)}`);
      return null;
    }
  }

  /** UI takeover input. Reuses the same sidecar/browser paths as the tools. */
  async applyUiInput(payload) {
    this.assertAlive();
    if (!this.takeover) throw new Error('请先接管该会话的虚拟桌面');
    const { kind, desktop } = payload ?? {};
    const scoped = desktop ? this.scopeName(desktop) : undefined;
    switch (kind) {
      case 'click':
        await this.sidecar.call('input.click', {
          desktop: scoped,
          x: payload.x,
          y: payload.y,
          button: payload.button ?? 'left',
          count: payload.count ?? 1,
          window: payload.window ?? null,
          settleMs: payload.settleMs ?? 120,
        });
        break;
      case 'drag':
        await this.sidecar.call('input.drag', {
          desktop: scoped,
          from: payload.from,
          to: payload.to,
          window: payload.window ?? null,
        });
        break;
      case 'scroll':
        await this.sidecar.call('input.scroll', {
          desktop: scoped,
          x: payload.x,
          y: payload.y,
          dy: payload.dy ?? 120,
          window: payload.window ?? null,
        });
        break;
      case 'type':
        await this.sidecar.call('input.type', {
          desktop: scoped,
          text: payload.text,
          window: payload.window ?? null,
        });
        break;
      case 'key':
        await this.sidecar.call('input.key', {
          desktop: scoped,
          keys: payload.keys,
          window: payload.window ?? null,
        });
        break;
      case 'browserClick':
        await this.browser().click(payload);
        break;
      case 'browserType':
        await this.browser().type(payload.text);
        break;
      case 'browserKey':
        await this.browser().key(payload.keys);
        break;
      default:
        throw new Error(`${UNSUPPORTED_INPUT}: ${String(kind)}`);
    }
    await this.refreshFrame(`ui:${kind}`, desktop);
    return { ok: true };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this.takeover = false;
    this._subscribers.clear();
    try {
      this._browser?.close();
    } catch {
      /* ignore */
    }
    try {
      this.sidecar?.stop();
    } catch {
      /* ignore */
    }
  }
}
