/**
 * Decisive probe for the monitor's frame-suppression bug.
 *
 * Drives a throwaway sidecar: create a desktop, type text, screenshot, type
 * different text, screenshot again — then compare the signatures the Host
 * monitor would compute. If they collide, `slice(-64)` is the bug.
 *
 *   node scripts/probe-signature.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, '..', 'sidecar', 'target', 'release', 'dshv.exe');

const proc = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.on('data', (b) => process.stderr.write('[sidecar] ' + b));
const rl = createInterface({ input: proc.stdout });
let seq = 0;
const pending = new Map();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
});

function call(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 60000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

const signature = (pngBase64, width, height) =>
  `${width}x${height}:${pngBase64.length}:${pngBase64.slice(-64)}`;

const name = 'probe-sig';
let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

try {
  const created = await call('desktop.create', { name, exe: 'notepad.exe', waitMs: 1200 });
  console.log('created:', JSON.stringify(created));

  const shot = async (tag) => {
    const s = await call('desktop.screenshot', { desktop: name, maxWidth: 960, maxHeight: 620 });
    return { tag, ...s, sig: signature(s.pngBase64, s.width, s.height) };
  };

  await call('input.type', { desktop: name, text: 'AAAA' });
  await new Promise((r) => setTimeout(r, 400));
  const a = await shot('AAAA');

  await call('input.type', { desktop: name, text: 'ZZZZ' });
  await new Promise((r) => setTimeout(r, 400));
  const b = await shot('ZZZZ');

  await call('input.type', { desktop: name, text: 'QQQQQQQQ' });
  await new Promise((r) => setTimeout(r, 400));
  const c = await shot('QQQQQQQQ');

  console.log(`A: ${a.width}x${a.height} len=${a.pngBase64.length}`);
  console.log(`   sig tail = ${a.sig.slice(a.sig.lastIndexOf(':') + 1)}`);
  console.log(`B: ${b.width}x${b.height} len=${b.pngBase64.length}`);
  console.log(`   sig tail = ${b.sig.slice(b.sig.lastIndexOf(':') + 1)}`);
  console.log(`C: ${c.width}x${c.height} len=${c.pngBase64.length}`);
  console.log(`   sig tail = ${c.sig.slice(c.sig.lastIndexOf(':') + 1)}`);

  check('A and B differ in pixels', a.pngBase64 !== b.pngBase64, `A=${a.pngBase64.length} B=${b.pngBase64.length}`);
  check('B and C differ in pixels', b.pngBase64 !== c.pngBase64);
  check('A and B signatures differ', a.sig !== b.sig, a.sig === b.sig ? 'COLLIDE' : '');
  check('B and C signatures differ', b.sig !== c.sig, b.sig === c.sig ? 'COLLIDE' : '');
  check('A and C signatures differ', a.sig !== c.sig, a.sig === c.sig ? 'COLLIDE' : '');

  // Same content twice must still collide — that is the intended suppression.
  const d = await shot('QQQQQQQQ again');
  check('identical content still suppresses', d.sig === c.sig);
} catch (e) {
  console.error('probe error:', e.message);
  failures++;
} finally {
  try {
    await call('desktop.close', { name });
  } catch {
    /* ignore */
  }
  proc.stdin.end();
  setTimeout(() => {
    console.log(failures === 0 ? '\nall signature checks passed' : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  }, 300);
}
