/**
 * Pure helpers shared by the Host monitor and the browser view.
 *
 * Nothing here touches a process, socket, or DOM, so these rules are cheap to
 * test and cannot accidentally become a second implementation of the tools.
 */

const MAX_ARG_TEXT = 120;
const MAX_ERROR_TEXT = 240;
const ARG_ALLOWLIST = new Set([
  'name',
  'desktop',
  'x',
  'y',
  'dy',
  'text',
  'keys',
  'button',
  'count',
  'from',
  'to',
  'window',
  'selector',
  'url',
]);

/**
 * A frame signature must depend on the whole image. Hashing the last bytes only
 * is a trap: two different frames can share length and tail and then the second
 * one is silently suppressed as "unchanged".
 */
export function frameSignature({ pngBase64, width, height }) {
  return `${width}x${height}:${pngBase64.length}:${hash(pngBase64)}`;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Map a point on the rendered image back to target-window pixels. */
export function toTargetPoint({ imageX, imageY, imageWidth, imageHeight, targetWidth, targetHeight }) {
  if (!(imageWidth > 0 && imageHeight > 0)) return { x: 0, y: 0 };
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  return {
    x: Math.round(clamp(imageX / imageWidth, 1) * targetWidth),
    y: Math.round(clamp(imageY / imageHeight, 1) * targetHeight),
  };
}

/** Keep the journal useful without shipping arbitrary tool arguments to the UI. */
export function normalizeJournalEntry(entry) {
  const args = {};
  for (const [key, value] of Object.entries(entry.args ?? {})) {
    if (!ARG_ALLOWLIST.has(key)) continue;
    args[key] = typeof value === 'string' ? value.slice(0, MAX_ARG_TEXT) : value;
  }
  return {
    at: entry.at,
    tool: entry.tool,
    args,
    ok: Boolean(entry.ok),
    error: entry.error ? String(entry.error).slice(0, MAX_ERROR_TEXT) : undefined,
    ms: entry.ms,
  };
}

/** One socket only ever sees its own session's data. */
export function belongsToSession(message, sessionId) {
  return Boolean(message && message.sessionId === sessionId);
}

/** `/vdesk/live?session=<id>` → id; anything malformed → undefined. */
export function sessionFromUpgradeUrl(url) {
  try {
    const parsed = new URL(url, 'http://localhost');
    const id = parsed.searchParams.get('session');
    if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) return undefined;
    return id;
  } catch {
    return undefined;
  }
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Only a page served from this Host may open the monitor socket. Without this,
 * any web page the user visits could connect to 127.0.0.1 and take over a
 * desktop. A missing Origin means a non-browser caller (host script), which is
 * already local and allowed.
 */
export function isSameOriginUpgrade(req) {
  const host = String(req?.headers?.host ?? '');
  if (!host || !LOOPBACK.test(host)) return false;
  const origin = String(req?.headers?.origin ?? req?.headers?.referer ?? '');
  if (!origin) return true;
  try {
    return LOOPBACK.test(new URL(origin).host);
  } catch {
    return false;
  }
}
