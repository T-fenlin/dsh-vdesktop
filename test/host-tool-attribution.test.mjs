import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('host tools resolve the calling session instead of using one global runtime', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /exec\.agent/);
  assert.match(source, /SessionRuntimes/);
  assert.doesNotMatch(source, /class Monitor/);
});

test('the old global overlay is gone from the client', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /shell\.overlay/);
});
