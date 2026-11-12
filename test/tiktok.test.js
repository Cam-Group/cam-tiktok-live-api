import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as piratetok from 'piratetok-live-js';
import { startTikTok } from '../src/tiktok.js';
import { root } from '../node_modules/piratetok-live-js/dist/proto/schema.js';
import { decode } from '../node_modules/piratetok-live-js/dist/events/router.js';

const E = piratetok.EventType;
const emptyUser = { id: '', nickname: '', uniqueId: '', avatarUrl: '', avatarThumb: '', avatarMedium: '', avatarLarge: '' };
const tick = () => new Promise(r => setImmediate(r));

// Fake TikTokLiveClient: outcome(client) determines whether connect() resolves or rejects.
function fakeLib(outcome) {
  const made = [];
  class FakeClient extends EventEmitter {
    constructor(name) { super(); this.name = name; this.disconnects = 0; made.push(this); }
    connect() { return outcome(this); }
    disconnect() { this.disconnects++; }
  }
  return { lib: { TikTokLiveClient: FakeClient, EventType: E }, made };
}

function recorder() {
  const log = { gifts: [], chats: [], likes: [], follows: [], shares: [], joins: [], viewers: [], status: [], opened: [], fails: [], lost: [] };
  const handlers = {
    onGift: g => log.gifts.push(g),
    onChat: c => log.chats.push(c),
    onLike: e => log.likes.push(e),
    onFollow: e => log.follows.push(e),
    onShare: e => log.shares.push(e),
    onJoin: e => log.joins.push(e),
    onViewers: e => log.viewers.push(e),
    onStatus: text => log.status.push(text),
    onOpen: roomId => log.opened.push(roomId),
    onFail: why => log.fails.push(why),
    onLost: why => log.lost.push(why),
  };
  return { log, handlers };
}

test('running gift combos are ignored; only completed combos are emitted', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('123'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  made[0].emit(E.gift, { isStreakOver: false, diamondTotal: 5, gift: { name: 'Rose' }, user: { nickname: 'Bob' } });
  made[0].emit(E.gift, { isStreakOver: true, diamondTotal: 50, gift: { name: 'Lion' }, user: { nickname: 'Bob', uniqueId: 'bob_1' } });
  assert.equal(log.gifts.length, 1);
  assert.deepEqual(log.gifts[0].user, { ...emptyUser, nickname: 'Bob', uniqueId: 'bob_1' });
  assert.equal(log.gifts[0].gift, 'Lion');
  assert.equal(log.gifts[0].diamonds, 50);
});

test('gifts with no diamonds are not emitted', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('1'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  made[0].emit(E.gift, { isStreakOver: true, diamondTotal: 0, user: { nickname: 'Z' } });
  assert.equal(log.gifts.length, 0);
});

test('chat includes user details and text, with an empty nickname when absent', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('1'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  made[0].emit(E.chat, { user: { nickname: 'Dan', uniqueId: 'dan_9' }, content: 'hi' });
  made[0].emit(E.chat, { user: { uniqueId: 'eve' }, content: '!' });
  const got = log.chats.map(c => [c.user, c.text]);
  assert.deepEqual(got, [[{ ...emptyUser, nickname: 'Dan', uniqueId: 'dan_9' }, 'hi'], [{ ...emptyUser, uniqueId: 'eve' }, '!']]);
});

test('a disconnect after connection triggers onLost once for retry', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('777'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  made[0].emit(E.disconnected, null);
  assert.deepEqual(log.opened, ['777']);
  assert.equal(log.lost.length, 1);
  assert.equal(log.fails.length, 0);
});

test('disconnected before rejection triggers onFail once, not onLost', async () => {
  const { lib, made } = fakeLib(c => new Promise((_, reject) => {
    c.emit(E.disconnected, null);
    reject(new Error('User is offline'));
  }));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  assert.equal(log.fails.length, 1);
  assert.match(log.fails[0], /^Could not connect to @alice: User is offline\.$/);
  assert.equal(log.lost.length, 0);
  assert.equal(made.length, 1);
});

test('LIVE end retires the old session and requests one username-level retry without a disconnect event', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('old-room'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  // Decode the same terminal control message used by the installed library.
  const type = root.lookupType('WebcastControlMessage');
  const payload = type.encode(type.fromObject({ action: 3 })).finish();
  for (const event of decode('WebcastControlMessage', payload)) made[0].emit(event.type, event.data);
  assert.deepEqual(log.lost, ['@alice has ended the live stream.']);
  assert.equal(made[0].disconnects, 1);
  const statuses = [...log.status];
  made[0].emit(E.liveEnded, {});
  made[0].emit(E.disconnected, null);
  made[0].emit(E.reconnecting, {});
  made[0].emit(E.chat, { content: 'stale session' });
  assert.deepEqual(log.lost, ['@alice has ended the live stream.']);
  assert.deepEqual(log.status, statuses);
  assert.deepEqual(log.chats, []);
});

test('LIVE end during handshake does not report a late old-room connection as open', async () => {
  let finish;
  const { lib, made } = fakeLib(() => new Promise(resolve => { finish = resolve; }));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  made[0].emit(E.liveEnded, {});
  finish('old-room');
  await tick();
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.lost, ['@alice has ended the live stream.']);
  assert.deepEqual(log.fails, []);
});

test('a late handshake failure after LIVE end cannot schedule a second retry', async () => {
  let fail;
  const { lib, made } = fakeLib(() => new Promise((_, reject) => { fail = reject; }));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  made[0].emit(E.liveEnded, {});
  fail(new Error('old room closed'));
  await tick();
  assert.deepEqual(log.lost, ['@alice has ended the live stream.']);
  assert.deepEqual(log.fails, []);
  assert.deepEqual(log.opened, []);
});

test('no callbacks are delivered after disconnect', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('1'));
  const { log, handlers } = recorder();
  const handle = startTikTok('alice', handlers, lib);
  await tick();
  handle.disconnect();
  made[0].emit(E.gift, { isStreakOver: true, diamondTotal: 10, user: { nickname: 'Bob' } });
  made[0].emit(E.chat, { user: { nickname: 'Bob' }, content: 'x' });
  for (const type of [E.like, E.follow, E.share, E.join, E.roomUserSeq]) made[0].emit(type, {});
  made[0].emit(E.reconnecting, {});
  made[0].emit(E.disconnected, null);
  assert.deepEqual(log.gifts, []);
  assert.deepEqual(log.chats, []);
  for (const key of ['likes', 'follows', 'shares', 'joins', 'viewers']) assert.deepEqual(log[key], []);
  assert.deepEqual(log.lost, []);
  assert.equal(made[0].disconnects, 1);
});

test('disconnect during connection closes a late connection without reporting it open', async () => {
  let finish;
  const { lib, made } = fakeLib(() => new Promise(resolve => { finish = resolve; }));
  const { log, handlers } = recorder();
  const handle = startTikTok('alice', handlers, lib);
  handle.disconnect();
  finish('42');
  await tick();
  assert.equal(made[0].disconnects, 2);
  assert.deepEqual(log.opened, []);
});

test('constructor errors trigger onFail without escaping', () => {
  const lib = { TikTokLiveClient: class { constructor() { throw new Error('invalid name'); } }, EventType: E };
  const { log, handlers } = recorder();
  const handle = startTikTok('x', handlers, lib);
  assert.equal(log.fails.length, 1);
  assert.equal(log.fails[0], 'Could not initialize the connection to @x: invalid name.');
  handle.disconnect();
});

test('synthetic Protobuf packets pass through the real router and adapter for all data events', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('777'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  await tick();
  const common = { msgId: '9223372036854775807', roomId: '777' };
  const user = { id: '9223372036854775806', nickname: 'An', uniqueId: 'an', avatarThumb: { urlList: ['https://example.com/an.jpg'] } };
  function deliver(method, fields) {
    const type = root.lookupType(method);
    const payload = type.encode(type.fromObject({ common, user, ...fields })).finish();
    for (const event of decode(method, payload)) made[0].emit(event.type, event.data);
  }
  deliver('WebcastChatMessage', { content: 'hello' });
  deliver('WebcastGiftMessage', { gift: { id: '42', name: 'Rose', type: 1, diamondCount: 2, image: { urlList: ['https://example.com/rose.jpg'] } }, repeatCount: 5, repeatEnd: 0 });
  assert.equal(log.gifts.length, 0);
  deliver('WebcastGiftMessage', { gift: { id: '42', name: 'Rose', type: 1, diamondCount: 2, image: { urlList: ['https://example.com/rose.jpg'] } }, repeatCount: 5, repeatEnd: 1 });
  deliver('WebcastLikeMessage', { count: 3, total: '100' });
  deliver('WebcastSocialMessage', { action: '1', followCount: '2' });
  deliver('WebcastSocialMessage', { action: '2', shareCount: 1, shareTarget: 'link' });
  deliver('WebcastMemberMessage', { action: 1, memberCount: 20 });
  deliver('WebcastRoomUserSeqMessage', { viewerCount: '20', totalUser: '300' });
  for (const key of ['gifts', 'chats', 'likes', 'follows', 'shares', 'joins', 'viewers']) {
    assert.equal(log[key].length, 1, key);
    assert.equal(log[key][0].eventId, common.msgId);
    assert.equal(log[key][0].roomId, '777');
    if (key !== 'viewers') {
      assert.equal(log[key][0].user.id, user.id);
      assert.equal(log[key][0].user.avatarUrl, user.avatarThumb.urlList[0]);
    }
  }
  assert.equal(log.gifts[0].diamonds, 10);
  assert.equal(log.gifts[0].repeatCount, 5);
  assert.equal(log.gifts[0].giftId, '42');
  assert.equal(log.gifts[0].giftImageUrl, 'https://example.com/rose.jpg');
  assert.equal(log.gifts[0].isCombo, true);
  assert.equal(log.likes[0].total, 100);
  assert.equal(log.viewers[0].viewerCount, 20);
  // Parent social/member messages must not duplicate follow/share/join events.
  deliver('WebcastMemberMessage', { action: 2 });
  deliver('WebcastSocialMessage', { action: '0' });
  assert.equal(log.joins.length, 1);
  assert.equal(log.follows.length, 1);
  assert.equal(log.shares.length, 1);
});

test('connection status and disconnect notices use English', async () => {
  const { lib, made } = fakeLib(() => Promise.resolve('777'));
  const { log, handlers } = recorder();
  startTikTok('alice', handlers, lib);
  assert.equal(log.status[0], 'Connecting to @alice (piratetok-live-js)...');
  await tick();
  assert.equal(log.status.at(-1), 'Connected to @alice (room 777). Waiting for events...');
  made[0].emit(E.reconnecting, {});
  assert.equal(log.status.at(-1), 'Reconnecting to @alice...');
  made[0].emit(E.liveEnded, {});
  assert.equal(log.status.at(-1), '@alice has ended the live stream.');
  made[0].emit(E.disconnected, null);
  assert.deepEqual(log.lost, ['@alice has ended the live stream.']);
});

test('library helpers end combos at repeatEnd = 1 and multiply gift price by quantity', () => {
  assert.equal(piratetok.isStreakOver({ gift: { type: 1 }, repeatEnd: 0 }), false);
  assert.equal(piratetok.isStreakOver({ gift: { type: 1 }, repeatEnd: 1 }), true);
  assert.equal(piratetok.isStreakOver({ gift: { type: 0 } }), true);
  assert.equal(piratetok.diamondTotal({ gift: { diamondCount: 2 }, repeatCount: 5 }), 10);
  assert.equal(piratetok.diamondTotal({ gift: { diamondCount: 2 } }), 2);
});
