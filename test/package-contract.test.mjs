import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package is public, versioned 0.2.3, and ships runtime files', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.2.3');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.repository.url, 'https://github.com/T-fenlin/dsh-vdesktop');
  for (const file of [
    'index.js',
    'client.js',
    'browser.js',
    'session-runtime.js',
    'monitor-protocol.js',
    'sidecar/target/release/dshv.exe',
  ]) {
    assert.ok(pkg.files.includes(file), `${file} missing from files`);
  }
  assert.ok(!pkg.files.includes('test'));
  assert.ok(!pkg.files.some((f) => f.startsWith('docs/evidence')));
});

test('bundle patch leaves inject to the module export', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  // A row-level `inject` overrides the module's `export const inject`, which
  // fails desktop activation. The patch must only carry the row and its config.
  assert.doesNotMatch(patch, /^\s*inject:/m);
  assert.match(patch, /id: dsh-vdesktop/);
  assert.match(patch, /name: dsh-vdesktop/);
});

test('locale metadata describes the session view in both languages', async () => {
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
    assert.ok(locale.meta.title);
    assert.ok(locale.meta.description.length > 20);
    for (const key of ['tab', 'takeover', 'release', 'journal', 'emptyBody']) {
      assert.ok(locale.view[key], `${lang} view.${key} missing`);
    }
  }
});
