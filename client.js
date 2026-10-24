/**
 * dsh-vdesktop — client half.
 *
 * A floating monitor that shows what the agent is doing inside the virtual
 * desktops: the tool-call journal and a live frame. The Host half pushes both
 * over one WebSocket, so this file only renders — it never captures anything.
 *
 * Registered on `shell.overlay`, the frame-wide floating layer, so it can sit
 * above every column and outside their scroll containers.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vdesktop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const WS_PATH = '/vdesk/live';
    const MAX_ROWS = 12;

    // Theme tokens the shell actually publishes.
    //
    // `var(--bg, #fff)` looks right and is a trap: `--bg` resolves to the LABEL
    // colour (white in dark mode), so the fallback never fires and the panel
    // paints a white surface with white text. Every colour below comes from a
    // real `--dsw-*` token, so the monitor follows 设置 → 外观 automatically.
    const C = {
      surface: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      screen: 'var(--dsw-alias-bg-base)',
    };

    /** `ws://host/vdesk/live`, matching whatever origin this page was served from. */
    function liveUrl() {
      const { protocol, host } = window.location;
      return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${WS_PATH}`;
    }

    function timeOf(at) {
      const d = new Date(at);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /** One-line summary of a tool call, so the journal stays scannable. */
    function summarize(entry) {
      const a = entry.args || {};
      switch (entry.tool) {
        case 'vdesk_open':
          return `open ${a.name} ← ${String(a.exe || '').split(/[\\/]/).pop()}`;
        case 'vdesk_click':
          return `click (${a.x}, ${a.y})`;
        case 'vdesk_scroll':
          return `scroll dy=${a.dy}`;
        case 'vdesk_type':
          return `type "${String(a.text || '').slice(0, 24)}"`;
        case 'vdesk_key':
          return `key ${(a.keys || []).join('+')}`;
        case 'vdesk_drag':
          return `drag (${a.from?.x},${a.from?.y})→(${a.to?.x},${a.to?.y})`;
        case 'vdesk_shot':
          return `shot ${a.name}`;
        default:
          return a.name || a.desktop || '';
      }
    }

    function MonitorPanel() {
      const [log, setLog] = useState([]);
      const [frame, setFrame] = useState(null);
      const [open, setOpen] = useState(false);
      const [state, setState] = useState('connecting');
      const socketRef = useRef(null);

      useEffect(() => {
        let alive = true;
        let retry = 0;
        let timer = null;

        const connect = () => {
          if (!alive) return;
          let socket;
          try {
            socket = new WebSocket(liveUrl());
          } catch {
            setState('error');
            return;
          }
          socketRef.current = socket;
          socket.onopen = () => {
            if (!alive) return socket.close();
            retry = 0;
            setState('live');
          };
          socket.onmessage = (event) => {
            let message;
            try {
              message = JSON.parse(event.data);
            } catch {
              return;
            }
            if (!alive) return;
            if (message.type === 'log') setLog(message.entries || []);
            else if (message.type === 'frame') setFrame(message);
          };
          socket.onclose = () => {
            if (!alive) return;
            setState('closed');
            // Reconnect with backoff; a Host restart must not need a page refresh.
            retry = Math.min(retry + 1, 6);
            timer = setTimeout(connect, 300 * 2 ** retry);
          };
          socket.onerror = () => setState('error');
        };
        connect();

        return () => {
          alive = false;
          clearTimeout(timer);
          socket?.close();
        };
      }, []);

      const dotColor =
        state === 'live' ? C.success : state === 'connecting' ? C.warn : C.error;

      const rows = log.slice(-MAX_ROWS).reverse();

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 8,
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          },
        },
        // Collapsed pill
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((v) => !v),
            title: open ? '收起虚拟桌面监视器' : '展开虚拟桌面监视器',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 999,
              border: `1px solid ${C.border}`,
              background: C.surface,
              color: C.text,
              fontSize: 12,
              cursor: 'pointer',
              boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
            },
          },
          h('span', {
            style: { width: 8, height: 8, borderRadius: '50%', background: dotColor, flex: 'none' },
          }),
          frame ? `虚拟桌面 ${frame.width}×${frame.height}` : '虚拟桌面',
          h('span', { style: { opacity: 0.6 } }, open ? '▾' : '▸'),
        ),

        open &&
          h(
            'div',
            {
              style: {
                width: 380,
                maxWidth: 'calc(100vw - 32px)',
                borderRadius: 12,
                border: `1px solid ${C.border}`,
                background: C.surface,
                color: C.text,
                boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
                overflow: 'hidden',
              },
            },
            // Frame
            frame
              ? h(
                  'div',
                  {
                    style: {
                      background: C.screen,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minHeight: 120,
                    },
                  },
                  h('img', {
                    src: `data:image/png;base64,${frame.pngBase64}`,
                    alt: `virtual desktop ${frame.desktop}`,
                    style: { display: 'block', width: '100%', height: 'auto' },
                  }),
                )
              : h(
                  'div',
                    {
                      style: {
                        padding: '24px 12px',
                        textAlign: 'center',
                        fontSize: 12,
                        opacity: 0.75,
                        color: C.muted,
                      },
                    },
                    '还没有画面——等 agent 第一次操作虚拟桌面',
                  ),

            // Journal
            h(
              'div',
              {
                style: {
                  padding: '8px 10px',
                  borderTop: `1px solid ${C.border}`,
                  fontSize: 11,
                  lineHeight: 1.6,
                  maxHeight: 168,
                  overflowY: 'auto',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                },
              },
              rows.length === 0
                ? h('div', { style: { opacity: 0.6, color: C.muted } }, '暂无操作')
                : rows.map((entry, i) =>
                    h(
                      'div',
                      {
                        key: `${entry.at}-${i}`,
                        style: {
                          display: 'flex',
                          gap: 6,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        },
                      },
                      h('span', { style: { opacity: 0.5, flex: 'none' } }, timeOf(entry.at)),
                      h('span', {
                        style: { flex: 'none', color: entry.ok ? C.success : C.error },
                      }, entry.ok ? '✓' : '✗'),
                      h('span', { style: { flex: 'none', opacity: 0.8 } }, entry.tool),
                      h('span', { style: { opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis' } }, summarize(entry)),
                      h('span', { style: { flex: 'none', opacity: 0.4, marginLeft: 'auto' } }, `${entry.ms}ms`),
                    ),
                  ),
            ),
          ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-vdesktop-monitor',
              order: 900,
              label: () => 'Virtual desktop monitor',
            },
            MonitorPanel,
          ),
        );
      },
    };
  },
});
