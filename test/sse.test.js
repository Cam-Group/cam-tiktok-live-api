import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFrame, writeFrame, emit, MAX_FRAME_BYTES, MAX_PENDING_BYTES } from '../src/sse.js';

function response(pending = 0) {
  return { destroyed: false, writableEnded: false, writableLength: pending, frames: [],
    write(frame) { this.frames.push(frame); }, destroy() { this.destroyed = true; } };
}

test('oversized UTF-8 frames are omitted without disconnecting healthy subscribers', () => {
  const res = response();
  const room = { clients: new Set([res]) };
  assert.equal(eventFrame('chat', { text: '👋'.repeat(MAX_FRAME_BYTES) }), null);
  emit(room, 'chat', { text: 'x'.repeat(MAX_FRAME_BYTES) });
  assert.equal(res.frames.length, 0);
  assert.equal(res.destroyed, false);
  emit(room, 'chat', { text: 'Hello' });
  assert.equal(res.frames.length, 1);
});

test('slow subscribers are disconnected before the pending-byte limit is exceeded', () => {
  const slow = response(MAX_PENDING_BYTES - 1), fast = response();
  emit({ clients: new Set([slow, fast]) }, 'chat', { text: 'Hello' });
  assert.equal(slow.destroyed, true);
  assert.equal(slow.frames.length, 0);
  assert.equal(fast.frames.length, 1);
});

test('closed responses and write errors do not break broadcasting to other clients', () => {
  assert.equal(writeFrame({ destroyed: true }, ': heartbeat\n\n'), false);
  const broken = response();
  broken.write = () => { throw new Error('closed'); };
  const good = response();
  emit({ clients: new Set([broken, good]) }, 'status', { text: 'ready' });
  assert.equal(broken.destroyed, true);
  assert.equal(good.frames.length, 1);
});
