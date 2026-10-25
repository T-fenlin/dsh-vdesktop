import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameSignature,
  toTargetPoint,
  normalizeJournalEntry,
  belongsToSession,
  sessionFromUpgradeUrl,
  isSameOriginUpgrade,
} from '../monitor-protocol.js';

test('frame signatures distinguish different pixel content with the same length and tail', () => {
  const a = { pngBase64: 'A'.repeat(200) + 'TAIL', width: 10, height: 10 };
  const b = { pngBase64: 'B'.repeat(200) + 'TAIL', width: 10, height: 10 };
  assert.notEqual(frameSignature(a), frameSignature(b));
});

test('toTargetPoint maps scaled image coordinates to target pixels', () => {
  assert.deepEqual(
    toTargetPoint({
      imageX: 320,
      imageY: 180,
      imageWidth: 640,
      imageHeight: 360,
      targetWidth: 1280,
      targetHeight: 720,
    }),
    { x: 640, y: 360 },
  );
});

test('toTargetPoint clamps outside points to the target bounds', () => {
  assert.deepEqual(
    toTargetPoint({
      imageX: -5,
      imageY: 999,
      imageWidth: 640,
      imageHeight: 360,
      targetWidth: 1280,
      targetHeight: 720,
    }),
    { x: 0, y: 720 },
  );
});

test('journal entries keep only display-safe fields and a bounded argument summary', () => {
  const entry = normalizeJournalEntry({
    at: 1,
    tool: 'vdesk_type',
    args: { name: 'task-1', text: 'x'.repeat(500), token: 'secret' },
    ok: true,
    ms: 12,
  });
  assert.equal(entry.tool, 'vdesk_type');
  assert.equal(entry.args.text.length, 120);
  assert.equal(entry.args.token, undefined);
});

test('messages are visible only to their owning session', () => {
  assert.equal(belongsToSession({ sessionId: 's1' }, 's1'), true);
  assert.equal(belongsToSession({ sessionId: 's2' }, 's1'), false);
  assert.equal(belongsToSession({ sessionId: undefined }, 's1'), false);
});

test('sessionFromUpgradeUrl reads a valid session and rejects the rest', () => {
  assert.equal(sessionFromUpgradeUrl('/vdesk/live?session=abc-123'), 'abc-123');
  assert.equal(sessionFromUpgradeUrl('/vdesk/live'), undefined);
  assert.equal(sessionFromUpgradeUrl('/vdesk/live?session='), undefined);
  assert.equal(sessionFromUpgradeUrl('/vdesk/live?session=bad%20id'), undefined);
});

test('upgrade requests from another web origin are rejected', () => {
  const local = { headers: { host: '127.0.0.1:49402', origin: 'http://127.0.0.1:49402' } };
  const remote = { headers: { host: '127.0.0.1:49402', origin: 'https://evil.example' } };
  const otherPort = { headers: { host: '127.0.0.1:49402', origin: 'http://127.0.0.1:3000' } };
  const noOrigin = { headers: { host: '127.0.0.1:49402' } };
  assert.equal(isSameOriginUpgrade(local), true);
  assert.equal(isSameOriginUpgrade(remote), false);
  assert.equal(isSameOriginUpgrade(otherPort), false);
  assert.equal(isSameOriginUpgrade(noOrigin), true);
});
