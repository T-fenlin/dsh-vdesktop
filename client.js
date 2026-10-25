/**
 * dsh-vdesktop — client half.
 *
 * A per-conversation "Virtual desktop" view tab. It shows the large live frame,
 * the tool-call journal, and — only after the user explicitly takes over — lets
 * the mouse and keyboard drive that conversation's desktop.
 *
 * The Host pushes only this session's data over `/vdesk/live?session=<id>`; the
 * same socket carries takeover input, so the view never invents a second control
 * channel. The tab is registered on `conversation.view`, the same row that holds
 * "轨迹", so every conversation gets its own page instead of one global overlay.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vdesktop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const WS_PATH = '/vdesk/live';
    const MAX_ROWS = 50;

    // Every colour is a host theme token: the view must follow 设置 → 外观 and
    // never paint a white surface with white text in dark mode.
    const C = {
      surface: 'var(--dsw-alias-bg-base)',
      raised: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const CSS = `
      [data-vd-page] {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: ${C.surface};
        color: ${C.text};
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 13px;
      }
      [data-vd-head] {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 10px 16px;
        border-bottom: 1px solid ${C.border};
        background: ${C.raised};
        flex: none;
      }
      [data-vd-status] { display: inline-flex; align-items: center; gap: 6px; color: ${C.muted}; font-size: 12px; }
      [data-vd-dot] { width: 7px; height: 7px; border-radius: 50%; flex: none; }
      [data-vd-mode] {
        font-size: 11px;
        letter-spacing: .04em;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid ${C.borderStrong};
        color: ${C.muted};
      }
      [data-vd-mode="takeover"] { color: ${C.warn}; border-color: ${C.warn}; }
      [data-vd-spacer] { flex: 1; }
      [data-vd-btn] {
        appearance: none;
        border: 1px solid ${C.borderStrong};
        background: ${C.nested};
        color: ${C.text};
        border-radius: 7px;
        padding: 5px 12px;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      [data-vd-btn]:hover { border-color: ${C.brand}; }
      [data-vd-btn]:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
      [data-vd-btn][data-primary] { background: ${C.brand}; border-color: ${C.brand}; color: ${C.surface}; }
      [data-vd-btn][disabled] { opacity: .45; cursor: default; }
      [data-vd-body] { flex: 1; min-height: 0; display: flex; overflow: hidden; }
      [data-vd-stage] {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        padding: 16px;
        gap: 10px;
        overflow: auto;
      }
      [data-vd-screen] {
        position: relative;
        flex: 1;
        min-height: 220px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid ${C.border};
        border-radius: 10px;
        background: ${C.nested};
        overflow: hidden;
      }
      [data-vd-screen][data-takeover] { cursor: crosshair; border-color: ${C.warn}; }
      [data-vd-screen]:focus-visible { outline: 2px solid ${C.brand}; outline-offset: 2px; }
      [data-vd-image] { display: block; max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
      [data-vd-empty] { text-align: center; color: ${C.muted}; line-height: 1.9; padding: 24px; max-width: 34em; }
      [data-vd-empty] strong { display: block; color: ${C.text}; font-size: 14px; margin-bottom: 4px; }
      [data-vd-caption] { display: flex; gap: 12px; color: ${C.muted}; font-size: 11px; flex: none; flex-wrap: wrap; }
      [data-vd-side] {
        width: 320px;
        flex: none;
        border-left: 1px solid ${C.border};
        background: ${C.raised};
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      [data-vd-side-head] { padding: 10px 12px; border-bottom: 1px solid ${C.border}; color: ${C.muted}; font-size: 11px; letter-spacing: .04em; }
      [data-vd-journal] { flex: 1; overflow: auto; padding: 6px 0; min-height: 0; }
      [data-vd-row] {
        display: grid;
        grid-template-columns: 52px 14px minmax(0, 1fr) auto;
        gap: 6px;
        align-items: baseline;
        padding: 5px 12px;
        font-size: 11px;
        line-height: 1.5;
      }
      [data-vd-row]:hover { background: ${C.nested}; }
      [data-vd-row][data-error] { background: ${C.nested}; }
      [data-vd-time] { color: ${C.muted}; font-variant-numeric: tabular-nums; }
      [data-vd-tool] { color: ${C.text}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      [data-vd-sum] { color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      [data-vd-ms] { color: ${C.muted}; font-variant-numeric: tabular-nums; }
      [data-vd-note] { padding: 14px 12px; color: ${C.muted}; font-size: 12px; line-height: 1.7; }
      [data-vd-err] {
        margin: 8px 16px 0;
        padding: 8px 10px;
        border: 1px solid ${C.error};
        border-radius: 8px;
        color: ${C.error};
        font-size: 12px;
      }
      [data-vd-stale] { color: ${C.warn}; }
      @media (max-width: 860px) {
        [data-vd-body] { flex-direction: column; }
        [data-vd-side] { width: auto; border-left: 0; border-top: 1px solid ${C.border}; max-height: 38%; }
      }
    `;

    /** `ws://host/vdesk/live?session=<id>` on whatever origin served this page. */
    function liveUrl(sessionId) {
      const { protocol, host } = window.location;
      return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${WS_PATH}?session=${encodeURIComponent(sessionId)}`;
    }

    function timeOf(at) {
      const d = new Date(at);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function summarize(entry) {
      const a = entry.args || {};
      switch (entry.tool) {
        case 'vdesk_open':
          return `打开 ${a.name} · ${String(a.exe || '').split(/[\\/]/).pop()}`;
        case 'vdesk_close':
          return `关闭 ${a.name}`;
        case 'vdesk_click':
          return `点击 (${a.x}, ${a.y})`;
        case 'vdesk_scroll':
          return `滚动 ${a.dy}`;
        case 'vdesk_type':
          return `输入 "${String(a.text || '').slice(0, 28)}"`;
        case 'vdesk_key':
          return `按键 ${(a.keys || []).join('+')}`;
        case 'vdesk_drag':
          return `拖拽 (${a.from?.x},${a.from?.y})→(${a.to?.x},${a.to?.y})`;
        case 'vdesk_shot':
          return `截图 ${a.name}`;
        case 'browser_open':
          return `打开网页 ${String(a.url || '').slice(0, 42)}`;
        case 'browser_click':
          return a.selector ? `点击 ${String(a.selector).slice(0, 32)}` : `点击 (${a.x}, ${a.y})`;
        case 'browser_type':
          return `输入 "${String(a.text || '').slice(0, 28)}"`;
        case 'browser_key':
          return `按键 ${(a.keys || []).join('+')}`;
        case 'browser_eval':
          return `执行脚本 ${String(a.expression || '').slice(0, 32)}`;
        default:
          return a.name || a.desktop || '';
      }
    }

    function DesktopView(props) {
      const sessionId = props.sessionId;
      const t = props.t ?? ((key) => key);
      const [state, setState] = useState('connecting');
      const [journal, setJournal] = useState([]);
      const [frame, setFrame] = useState(null);
      const [takeover, setTakeover] = useState(false);
      const [error, setError] = useState('');
      const socketRef = useRef(null);
      const dragRef = useRef(null);
      const seqRef = useRef(0);

      useEffect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-vd-css', 'dsh-vdesktop');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, []);

      useEffect(() => {
        if (!sessionId) return undefined;
        let alive = true;
        let retry = 0;
        let timer = null;

        const connect = () => {
          if (!alive) return;
          let socket;
          try {
            socket = new WebSocket(liveUrl(sessionId));
          } catch {
            setState('error');
            return;
          }
          socketRef.current = socket;
          socket.onopen = () => {
            if (!alive) return socket.close();
            retry = 0;
            setState('live');
            setError('');
          };
          socket.onmessage = (event) => {
            let message;
            try {
              message = JSON.parse(event.data);
            } catch {
              return;
            }
            if (!alive) return;
            if (message.type === 'snapshot') {
              setJournal(message.journal || []);
              setFrame(message.frame || null);
              setTakeover(Boolean(message.takeover));
            } else if (message.type === 'journal') {
              setJournal(message.entries || []);
            } else if (message.type === 'frame') {
              setFrame(message);
            } else if (message.type === 'state') {
              setTakeover(Boolean(message.takeover));
            } else if (message.type === 'input-error') {
              setError(message.error || t('view.inputFailed'));
            }
          };
          socket.onclose = () => {
            if (!alive) return;
            setState('closed');
            setTakeover(false);
            retry = Math.min(retry + 1, 6);
            timer = setTimeout(connect, 300 * 2 ** retry);
          };
          socket.onerror = () => setState('error');
        };
        connect();
        return () => {
          alive = false;
          clearTimeout(timer);
          socketRef.current?.close();
        };
      }, [sessionId, t]);

      const send = useCallback((message) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== 1) {
          setError(t('view.offline'));
          return false;
        }
        socket.send(JSON.stringify(message));
        return true;
      }, [t]);

      const toggleTakeover = useCallback(() => {
        if (takeover) send({ type: 'release' });
        else send({ type: 'takeover' });
      }, [takeover, send]);

      const sendInput = useCallback((payload) => {
        const id = ++seqRef.current;
        send({ type: 'input', id, payload });
      }, [send]);

      const imagePoint = (event) => {
        const img = event.currentTarget;
        const rect = img.getBoundingClientRect();
        const naturalWidth = img.naturalWidth || frame?.width || 0;
        const naturalHeight = img.naturalHeight || frame?.height || 0;
        if (!naturalWidth || !naturalHeight) return null;
        const x = ((event.clientX - rect.left) / rect.width) * naturalWidth;
        const y = ((event.clientY - rect.top) / rect.height) * naturalHeight;
        return {
          x: Math.max(0, Math.min(naturalWidth, Math.round(x))),
          y: Math.max(0, Math.min(naturalHeight, Math.round(y))),
        };
      };

      const desktop = frame?.desktop;
      const live = state === 'live';

      const onPointerDown = (event) => {
        if (!takeover || !desktop) return;
        const point = imagePoint(event);
        if (!point) return;
        event.preventDefault();
        event.currentTarget.focus();
        if (event.button === 2) {
          sendInput({ kind: 'click', desktop, x: point.x, y: point.y, button: 'right' });
          return;
        }
        dragRef.current = { from: point, moved: false };
        sendInput({ kind: 'click', desktop, x: point.x, y: point.y, button: 'left' });
      };

      const onPointerUp = (event) => {
        if (!takeover || !desktop) return;
        const start = dragRef.current;
        dragRef.current = null;
        if (!start) return;
        const end = imagePoint(event);
        if (!end) return;
        if (Math.abs(end.x - start.from.x) > 4 || Math.abs(end.y - start.from.y) > 4) {
          sendInput({ kind: 'drag', desktop, from: start.from, to: end });
        }
      };

      const onWheel = (event) => {
        if (!takeover || !desktop) return;
        const point = imagePoint(event);
        if (!point) return;
        event.preventDefault();
        sendInput({ kind: 'scroll', desktop, x: point.x, y: point.y, dy: event.deltaY > 0 ? 120 : -120 });
      };

      const onKeyDown = (event) => {
        if (!takeover || !desktop) return;
        const control = event.ctrlKey || event.metaKey;
        const named = {
          Enter: 'enter',
          Escape: 'escape',
          Tab: 'tab',
          Backspace: 'backspace',
          Delete: 'delete',
          ArrowLeft: 'left',
          ArrowRight: 'right',
          ArrowUp: 'up',
          ArrowDown: 'down',
          Home: 'home',
          End: 'end',
          PageUp: 'pageup',
          PageDown: 'pagedown',
        };
        let keys = null;
        if (named[event.key]) keys = [control ? `ctrl+${named[event.key]}` : named[event.key]];
        else if (event.key.length === 1 && !control && !event.altKey) {
          event.preventDefault();
          sendInput({ kind: 'type', desktop, text: event.key });
          return;
        } else if (event.key.length === 1 && control) {
          keys = [`ctrl+${event.key.toLowerCase()}`];
        }
        if (!keys) return;
        event.preventDefault();
        sendInput({ kind: 'key', desktop, keys });
      };

      const rows = useMemo(() => journal.slice(-MAX_ROWS).slice().reverse(), [journal]);

      const statusColor = live ? C.success : state === 'connecting' ? C.warn : C.error;

      return h(
        'div',
        { 'data-vd-page': '' },
        h(
          'div',
          { 'data-vd-head': '' },
          h(
            'span',
            { 'data-vd-status': '', title: t('view.connection') },
            h('span', { 'data-vd-dot': '', style: { background: statusColor } }),
            live ? t('view.live') : state === 'connecting' ? t('view.connecting') : t('view.reconnecting'),
          ),
          frame
            ? h('span', { 'data-vd-status': '' }, `${frame.desktop} · ${frame.width}×${frame.height}`)
            : null,
          h('span', { 'data-vd-mode': takeover ? 'takeover' : 'watch' },
            takeover ? t('view.takeoverOn') : t('view.watch')),
          h('span', { 'data-vd-spacer': '' }),
          h(
            'button',
            {
              type: 'button',
              'data-vd-btn': '',
              'data-primary': takeover ? undefined : '',
              disabled: !live || !frame,
              onClick: toggleTakeover,
            },
            takeover ? t('view.release') : t('view.takeover'),
          ),
        ),
        error ? h('div', { 'data-vd-err': '' }, error) : null,
        h(
          'div',
          { 'data-vd-body': '' },
          h(
            'div',
            { 'data-vd-stage': '' },
            h(
              'div',
              {
                'data-vd-screen': '',
                'data-takeover': takeover ? '' : undefined,
                tabIndex: takeover ? 0 : -1,
                role: 'application',
                'aria-label': t('view.stageLabel'),
                onPointerDown,
                onPointerUp,
                onWheel,
                onKeyDown,
                onContextMenu: (event) => {
                  if (takeover) event.preventDefault();
                },
              },
              frame
                ? h('img', {
                    'data-vd-image': '',
                    src: `data:image/png;base64,${frame.pngBase64}`,
                    alt: `${t('view.frameAlt')} ${frame.desktop}`,
                    draggable: false,
                  })
                : h(
                    'div',
                    { 'data-vd-empty': '' },
                    h('strong', null, t('view.emptyTitle')),
                    t('view.emptyBody'),
                  ),
            ),
            h(
              'div',
              { 'data-vd-caption': '' },
              h('span', null, takeover ? t('view.takeoverHint') : t('view.watchHint')),
              state !== 'live' && frame
                ? h('span', { 'data-vd-stale': '' }, t('view.stale'))
                : null,
            ),
          ),
          h(
            'aside',
            { 'data-vd-side': '' },
            h('div', { 'data-vd-side-head': '' }, t('view.journal').replace('{n}', String(journal.length))),
            rows.length === 0
              ? h('div', { 'data-vd-note': '' }, t('view.journalEmpty'))
              : h(
                  'div',
                  { 'data-vd-journal': '' },
                  rows.map((entry, index) =>
                    h(
                      'div',
                      {
                        key: `${entry.at}-${index}`,
                        'data-vd-row': '',
                        'data-error': entry.ok ? undefined : '',
                        title: entry.error || '',
                      },
                      h('span', { 'data-vd-time': '' }, timeOf(entry.at)),
                      h(
                        'span',
                        { style: { color: entry.ok ? C.success : C.error } },
                        entry.ok ? '✓' : '✗',
                      ),
                      h(
                        'span',
                        null,
                        h('div', { 'data-vd-tool': '' }, entry.tool),
                        h('div', { 'data-vd-sum': '' }, summarize(entry)),
                      ),
                      h('span', { 'data-vd-ms': '' }, `${entry.ms ?? 0}ms`),
                    ),
                  ),
                ),
          ),
        ),
      );
    }

    // Dictionaries live in the package's locale JSON and must be registered with
    // the Client locale service; a label thunk alone renders the raw key.
    const ZH = {
      'view.tab': '虚拟桌面',
      'view.connection': '连接状态',
      'view.live': '已连接',
      'view.connecting': '连接中',
      'view.reconnecting': '连接断开，正在重连',
      'view.watch': '观看',
      'view.takeoverOn': '你正在接管',
      'view.takeover': '接管操作',
      'view.release': '交还 Agent',
      'view.stageLabel': '虚拟桌面画面',
      'view.frameAlt': '虚拟桌面画面',
      'view.emptyTitle': '还没有画面',
      'view.emptyBody': '先让 Agent 打开一个程序或网页，它的画面和操作会显示在这里。',
      'view.watchHint': '观看模式：点击画面不会操作目标程序。',
      'view.takeoverHint': '接管中：鼠标与键盘直接操作这个会话的桌面；操作期间 Agent 会暂停。',
      'view.stale': '连接已断开，画面可能不是最新的。',
      'view.journal': '操作记录（{n}）',
      'view.journalEmpty': '暂无操作。Agent 每次操作虚拟桌面后都会记在这里。',
      'view.inputFailed': '操作失败',
      'view.offline': '连接已断开，暂时无法操作。',
    };

    const EN = {
      'view.tab': 'Virtual desktop',
      'view.connection': 'Connection',
      'view.live': 'Connected',
      'view.connecting': 'Connecting',
      'view.reconnecting': 'Disconnected, reconnecting',
      'view.watch': 'Watching',
      'view.takeoverOn': 'You have control',
      'view.takeover': 'Take control',
      'view.release': 'Hand back to agent',
      'view.stageLabel': 'Virtual desktop screen',
      'view.frameAlt': 'Virtual desktop frame',
      'view.emptyTitle': 'No picture yet',
      'view.emptyBody': 'Ask the agent to open an app or a web page; its screen and actions will appear here.',
      'view.watchHint': 'Watching: clicks here do not reach the target app.',
      'view.takeoverHint': "In control: mouse and keyboard drive this conversation's desktop; the agent is paused meanwhile.",
      'view.stale': 'Connection lost — this picture may be out of date.',
      'view.journal': 'Activity ({n})',
      'view.journalEmpty': 'No activity yet. Each desktop action by the agent is recorded here.',
      'view.inputFailed': 'The action failed',
      'view.offline': 'Disconnected, so this action was not sent.',
    };

    return {
      // `uiConversation` makes this plugin activate AFTER
      // dsh-client-ui-conversation has declared `conversation.view`, so
      // slots.inject() runs our registration synchronously inside apply()
      // (its declaration-wait path otherwise defers the callback, whose
      // failures escape as unhandled async effect errors). A synchronous
      // failure is caught and logged by the try/catch below instead of
      // turning into "web boot: 1 entry did not activate / dsh-vdesktop:
      // failed". A service name is enough: no Harness package is imported.
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        // A dynamic Client half may expose services through `ctx.get` only; the
        // shipped plugins use both forms. Falling back keeps the tab registering
        // on every shell generation instead of silently doing nothing.
        const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined) || ctx[name];
        const slots = get('slots');
        if (!slots || typeof slots.register !== 'function') {
          console.warn('[dsh-vdesktop] slots service unavailable; virtual desktop tab not registered');
          return;
        }
        const locale = get('locale');
        if (locale?.register) {
          ctx.effect?.(() => locale.register('dsh-vdesktop', { zh: ZH, en: EN }), 'dsh-vdesktop: locale');
        }
        const t = locale?.bind ? locale.bind('dsh-vdesktop') : (key) => ZH[key] ?? key;
        // Registration must never take down the whole web boot: if the slot
        // contract drifts (duplicate occupant id, changed descriptor shape),
        // log the real error instead of throwing out of apply().
        // console.error at error level is captured by the desktop crash log's
        // renderer-console section, so the next failure is self-explaining.
        try {
          slots.inject('conversation.view', () =>
            slots.register(
              {
                name: 'conversation.view',
                id: 'virtual-desktop',
                order: 20,
                scope: 'session',
                label: () => t('view.tab'),
                inject: (sessionId) => ({ sessionId, t }),
              },
              DesktopView,
            ),
          );
        } catch (error) {
          console.error('[dsh-vdesktop] failed to register conversation.view tab:', error);
        }
      },
    };
  },
});
