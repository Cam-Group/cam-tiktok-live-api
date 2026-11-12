import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/events.js';

const image = (...urlList) => ({ urlList });
const emptyUser = { id: '', nickname: '', uniqueId: '', avatarUrl: '', avatarThumb: '', avatarMedium: '', avatarLarge: '' };

test('chat preserves metadata, exact 64-bit IDs and avatar URLs', () => {
  const event = normalizeEvent('chat', {
    common: { msgId: '9223372036854775807', roomId: '9223372036854775806' },
    user: {
      id: '9223372036854775805', nickname: 'An', uniqueId: 'an_1',
      avatarThumb: image('https://example.com/thumb.jpg'),
      avatarMedium: image('https://example.com/medium.jpg'),
      avatarLarge: image('https://example.com/large.jpg'),
    },
    content: 'Hello 👋',
  });
  assert.equal(event.eventId, '9223372036854775807');
  assert.equal(event.roomId, '9223372036854775806');
  assert.equal(event.user.id, '9223372036854775805');
  assert.equal(event.user.avatarUrl, 'https://example.com/thumb.jpg');
  assert.equal(event.user.avatarMedium, 'https://example.com/medium.jpg');
  assert.equal(event.user.avatarLarge, 'https://example.com/large.jpg');
  assert.equal(event.text, 'Hello 👋');
  assert.ok(Number.isSafeInteger(event.ts));
});

test('avatars select valid HTTP(S) URLs and fall back across sizes without extra requests', () => {
  const event = normalizeEvent('chat', {
    user: { avatarThumb: image(null, 'javascript:alert(1)', 'bad', 'https://example.com/a.jpg?token=abc') },
  });
  assert.equal(event.user.avatarUrl, 'https://example.com/a.jpg?token=abc');
  const fallback = normalizeEvent('chat', { user: { avatarMedium: image('https://example.com/m.jpg') } });
  assert.equal(fallback.user.avatarThumb, '');
  assert.equal(fallback.user.avatarUrl, 'https://example.com/m.jpg');
  assert.equal(normalizeEvent('chat', { user: { avatarLarge: image('https://example.com/l.jpg') } }).user.avatarUrl, 'https://example.com/l.jpg');
  assert.equal(normalizeEvent('chat', { user: { avatarThumb: { urlList: 'not-an-array' } } }).user.avatarUrl, '');
  assert.deepEqual(normalizeEvent('chat').user, emptyUser);
  assert.deepEqual(normalizeEvent('chat', { user: { nickname: {}, uniqueId: 123 } }).user, emptyUser);
});

test('safe numeric IDs become strings; imprecise numeric IDs are discarded', () => {
  const event = normalizeEvent('chat', { common: { msgId: 123, roomId: Number.MAX_SAFE_INTEGER + 1 }, user: { id: Number.MAX_SAFE_INTEGER + 1 } });
  assert.equal(event.eventId, '123');
  assert.equal(event.roomId, '');
  assert.equal(event.user.id, '');
});

test('gifts include sender avatars, gift images and combo details while preserving the total', () => {
  const event = normalizeEvent('gift', {
    user: { id: '123', avatarThumb: image('https://example.com/user.jpg') },
    gift: { id: '456', name: 'Rose', image: image('https://example.com/rose.jpg'), diamondCount: '2' },
    repeatCount: '5', diamondTotal: 10, isStreakOver: true, isCombo: true, groupId: '9223372036854775807',
  });
  assert.equal(event.gift, 'Rose');
  assert.equal(event.giftId, '456');
  assert.equal(event.giftImageUrl, 'https://example.com/rose.jpg');
  assert.equal(event.user.avatarUrl, 'https://example.com/user.jpg');
  assert.equal(event.repeatCount, 5);
  assert.equal(event.diamondCount, 2);
  assert.equal(event.diamonds, 10);
  assert.equal(event.comboId, '9223372036854775807');
  assert.equal(event.isCombo, true);
  assert.equal(event.isStreakOver, true);
  const missing = normalizeEvent('gift', { giftId: 7, gift: { icon: image('https://example.com/icon.jpg') }, isStreakOver: true, diamondTotal: 1 });
  assert.equal(missing.giftId, '7');
  assert.equal(missing.giftImageUrl, 'https://example.com/icon.jpg');
  assert.equal(missing.diamondCount, null);
  assert.equal(missing.repeatCount, 1);
});

test('unfinished combos and invalid or nonpositive diamond totals are not emitted', () => {
  assert.equal(normalizeEvent('gift', { isStreakOver: false, diamondTotal: 10 }), null);
  for (const diamondTotal of [undefined, null, '', 'bad', true, -1, 0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeEvent('gift', { isStreakOver: true, diamondTotal }), null);
  }
});

test('common events preserve zero and normalize missing or invalid counters', () => {
  assert.equal(normalizeEvent('like', { count: '3', total: '0' }).count, 3);
  assert.equal(normalizeEvent('like', { count: '3', total: '0' }).total, 0);
  assert.equal(normalizeEvent('follow', { followCount: '2' }).followCount, 2);
  assert.equal(normalizeEvent('share', { shareCount: 1, shareTarget: 'link' }).target, 'link');
  assert.equal(normalizeEvent('join', { memberCount: 0 }).memberCount, 0);
  const viewers = normalizeEvent('viewers', { viewerCount: '20', totalUser: '300' });
  assert.equal(viewers.viewerCount, 20);
  assert.equal(viewers.totalUser, 300);
  assert.equal('user' in viewers, false);
  assert.equal(normalizeEvent('viewers').viewerCount, null);
  for (const invalid of [undefined, null, '', false, -1, Infinity, 'NaN', '1.5', '9007199254740992']) {
    assert.equal(normalizeEvent('like', { count: invalid }).count, null);
  }
});
