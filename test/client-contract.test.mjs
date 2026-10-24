import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('client registers a conversation view, not a shell overlay', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /conversation\.view/);
  assert.doesNotMatch(source, /shell\.overlay/);
});

test('client uses only theme tokens, never literal colors', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const css = source.slice(source.indexOf('const CSS'));
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\brgba?\(/);
  assert.match(source, /--dsw-alias-/);
});

test('client wires takeover input through the session socket', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /type: 'takeover'/);
  assert.match(source, /type: 'release'/);
  assert.match(source, /type: 'input'/);
  assert.match(source, /session=\$\{encodeURIComponent\(sessionId\)\}/);
});

test('client never imports a Harness Client package', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-client-/);
});
