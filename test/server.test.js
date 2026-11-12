import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { EventType } from 'piratetok-live-js';
import { createBackend } from '../server.js';
import { startTikTok } from '../src/tiktok.js';
import { configured } from '../test-support/backend-env.js';

async function backend(t, { testEvents = false, origins = '', connectTikTok } = {}) {
  const connections = [];
  const server = configured({ TEST_GIFTS: testEvents ? '1' : '0', ALLOWED_ORIGINS: origins }, () =>
    createBackend(connectTikTok ?? ((name, handlers) => {
      const connection = { name, handlers, disconnects: 0 };
      connections.push(connection);
      handlers.onStatus('ready');
      return { disconnect() { connection.disconnects++; } };
    })));

  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, connections };
}

function stream(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const queue = [], waiters = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer.slice(0, end).split('\n');
          buffer = buffer.slice(end + 2);
          const type = lines.find(line => line.startsWith('event: '))?.slice(7);
          const data = lines.find(line => line.startsWith('data: '));
          if (!type || !data) continue;
          const event = { type, data: JSON.parse(data.slice(6)) };
          const index = waiters.findIndex(waiter => waiter.type === type);
          if (index < 0) queue.push(event);
          else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(event.data); }
        }
      });
      resolve({
        next(type) {
          const index = queue.findIndex(event => event.type === type);
          if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0].data);
          return new Promise((resolve, reject) => {
            const waiter = { type, resolve };
            waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Missing event: ${type}`)); }, 2000);
            waiters.push(waiter);
          });
        },
      });
    });
    req.on('error', reject);
  });
}

const eventTypes = ['chat', 'gift', 'like', 'follow', 'share', 'join', 'viewers'];

test('HTTP/SSE broadcasts every event to shared clients and isolates different rooms', { timeout: 5000 }, async t => {
  const { base, connections } = await backend(t);
  const a = await stream(`${base}/events?username=alice`);
  const b = await stream(`${base}/events?username=@alice`);
  const other = await stream(`${base}/events?username=bob`);
  assert.deepEqual(connections.map(c => c.name), ['alice', 'bob']);
  assert.equal((await a.next('status')).text, 'ready');
  for (const type of eventTypes) {
    const payload = { user: { nickname: 'An' }, diamonds: 10, marker: type };
    const handler = `on${type[0].toUpperCase()}${type.slice(1)}`;
    connections[0].handlers[handler](payload);
    connections[1].handlers[handler]({ ...payload, marker: 'bob' });
    assert.deepEqual(await a.next(type), payload);
    assert.deepEqual(await b.next(type), payload);
    assert.equal((await other.next(type)).marker, 'bob');
  }
});

test('a username recovers from LIVE end through offline retries into a new room without restarting SSE', { timeout: 5000 }, async t => {
  const timers = [];
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = nativeTimeout(callback, ms, ...args);
    if (ms === 3000 || ms === 30000) timers.push({ timer, callback, ms });
    return timer;
  });
  const turn = () => new Promise(resolve => setImmediate(resolve));
  async function retryAfter(ms) {
    assert.equal(timers.length, 1, 'only one backend retry is pending');
    const pending = timers.shift();
    assert.equal(pending.ms, ms);
    clearTimeout(pending.timer);
    pending.callback();
    await turn();
  }
  let onlineRoom = 'old-room';
  const clients = [];
  class Client extends EventEmitter {
    constructor(name) { super(); this.name = name; this.disconnects = 0; clients.push(this); }
    connect() {
      this.roomId = onlineRoom;
      return onlineRoom ? Promise.resolve(onlineRoom) : Promise.reject(new Error('User is offline'));
    }
    disconnect() { this.disconnects++; this.emit(EventType.disconnected, null); }
  }
  const lib = { TikTokLiveClient: Client, EventType };
  const { base } = await backend(t, { connectTikTok: (name, handlers) => startTikTok(name, handlers, lib) });
  const first = await stream(`${base}/events?username=alice`);
  await turn();
  assert.equal(clients.length, 1);
  onlineRoom = null;
  clients[0].emit(EventType.liveEnded, {});
  const second = await stream(`${base}/events?username=alice`);
  assert.match((await second.next('status')).text, /ended the live stream.*Retrying in 3s/);
  assert.equal(clients.length, 1, 'a new subscriber shares the existing username retry');
  clients[0].emit(EventType.liveEnded, {});
  clients[0].emit(EventType.disconnected, null);
  assert.equal(clients[0].disconnects, 1);
  await retryAfter(3000);
  assert.equal(clients.length, 2);
  await retryAfter(3000);
  assert.equal(clients.length, 3);
  onlineRoom = 'new-room';
  await retryAfter(30000);
  assert.equal(clients.length, 4);
  assert.equal(clients[3].name, 'alice');
  assert.equal(clients[3].roomId, 'new-room');
  assert.equal(timers.length, 0);
  clients[0].emit(EventType.chat, { content: 'stale message' });
  clients[3].emit(EventType.chat, { common: { roomId: 'new-room' }, content: 'new LIVE' });
  for (const subscriber of [first, second]) {
    const chat = await subscriber.next('chat');
    assert.equal(chat.roomId, 'new-room');
    assert.equal(chat.text, 'new LIVE');
  }
  clients[3].emit(EventType.liveEnded, {});
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 3000, 'a successful new LIVE resets retry backoff');
});

test('closing active SSE sockets cleans up every upstream room', { timeout: 5000 }, async t => {
  const { server, base, connections } = await backend(t);
  await stream(`${base}/events?username=alice`);
  await stream(`${base}/events?username=bob`);
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await closed;
  assert.deepEqual(connections.map(connection => connection.disconnects), [1, 1]);
});

test('simulation endpoints use normalized payloads and support every data event', { timeout: 5000 }, async t => {
  const { base } = await backend(t, { testEvents: true });
  const a = await stream(`${base}/events?username=alice`);
  const b = await stream(`${base}/events?username=bob`);
  for (const type of eventTypes) {
    const params = new URLSearchParams({
      username: 'alice', name: 'An', userId: '9223372036854775807',
      avatar: 'https://example.com/an.jpg', giftImage: 'https://example.com/rose.jpg',
      giftId: '123', diamonds: '10', diamondCount: '2', repeatCount: '5', text: 'hello',
      count: '3', total: '100', followCount: '2', memberCount: '20', viewerCount: '20', totalUser: '300',
    });
    const res = await fetch(`${base}/${type}?${params}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok (rooms: 1)\n');
    const event = await a.next(type);
    if (type !== 'viewers') {
      assert.equal(event.user.avatarUrl, 'https://example.com/an.jpg');
      assert.equal(event.user.id, '9223372036854775807');
    }
    if (type === 'gift') { assert.equal(event.diamonds, 10); assert.equal(event.repeatCount, 5); assert.equal(event.giftImageUrl, 'https://example.com/rose.jpg'); }
    if (type === 'viewers') assert.equal(event.viewerCount, 20);
    // A targeted event must arrive before any event from another room.
    const bobRes = await fetch(`${base}/${type}?username=bob&name=Bob&viewerCount=99`);
    await bobRes.text();
    const bob = await b.next(type);
    if (type === 'viewers') assert.equal(bob.viewerCount, 99);
    else assert.equal(bob.user.nickname, 'Bob');
  }
  const broadcast = await fetch(`${base}/like?count=1`);
  assert.equal(await broadcast.text(), 'ok (rooms: 2)\n');
  const broadcastEvent = await a.next('like');
  assert.equal(broadcastEvent.count, 1);
  assert.equal(broadcastEvent.user.nickname, 'Guest');
  assert.equal((await b.next('like')).count, 1);
  for (const [path, message] of [
    ['/gift?diamonds=-1', 'Invalid diamonds\n'],
    ['/gift?diamonds=0', 'Gift diamonds must be greater than 0\n'],
    ['/like?count=bad', 'Invalid count\n'],
    ['/viewers?viewerCount=9007199254740992', 'Invalid viewerCount\n'],
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 400);
    assert.equal(await res.text(), message);
  }
});

test('validation, CORS and disabled simulation routes remain enforced', async t => {
  const { base, connections } = await backend(t, { origins: 'https://game.example' });
  for (const type of eventTypes) {
    const res = await fetch(`${base}/${type}`); await res.text(); assert.equal(res.status, 404);
  }
  const root = await fetch(`${base}/`);
  assert.equal(await root.text(), 'TikTok LIVE backend is running. Use /events?username=your_username\n');
  const invalid = await fetch(`${base}/events?username=bad!`);
  assert.equal(invalid.status, 400);
  assert.equal(await invalid.text(), 'Invalid username\n');
  const denied = await fetch(`${base}/events?username=alice`, { headers: { Origin: 'https://bad.example' } });
  await denied.text(); assert.equal(denied.status, 403);
  const preflight = await fetch(`${base}/events`, { method: 'OPTIONS', headers: { Origin: 'https://game.example' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://game.example');
  assert.equal(connections.length, 0);
});

test('simulation routes reject cross-site requests and disallowed origins', async t => {
  const { base } = await backend(t, { testEvents: true, origins: 'https://game.example' });
  for (const headers of [{ Origin: 'https://bad.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const res = await fetch(`${base}/like?count=1`, { headers }); await res.text(); assert.equal(res.status, 403);
  }
});
