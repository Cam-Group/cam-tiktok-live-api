import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TikTokLiveClient, checkOnline, EventType } from 'piratetok-live-js';
import { fetchTTWID } from '../node_modules/piratetok-live-js/dist/auth/ttwid.js';

const online = JSON.stringify({ statusCode: 0, data: { user: { roomId: '123', status: 2 }, liveRoom: { status: 2 } } });

function stalledBody(t, signal) {
  let controller;
  const abort = () => controller.error(signal.reason);
  const response = new Response(new ReadableStream({ start(value) { controller = value; } }));
  signal.addEventListener('abort', abort, { once: true });
  t.after(() => {
    signal.removeEventListener('abort', abort);
    try { controller.close(); } catch {}
  });
  return response;
}

test('room lookup deadline includes a response body stalled after headers', { timeout: 2000 }, async t => {
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return stalledBody(t, signal);
  });
  const pending = checkOnline('alice', 20);
  pending.catch(() => {});
  await delay(60);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, error => ['TimeoutError', 'AbortError'].includes(error.name));
});

test('disconnect during room discovery aborts lookup and never starts a late session', async t => {
  let release, signal, starts = 0;
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    release = () => { signal.removeEventListener('abort', abort); resolve(new Response(online)); };
  }));
  class Client extends TikTokLiveClient {
    runSessions(roomId) { starts++; return Promise.resolve(roomId); }
  }
  const client = new Client('alice');
  const pending = client.connect();
  pending.catch(() => {});
  t.after(() => { client.disconnect(); release(); });
  client.disconnect();
  release();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(starts, 0);
});

test('disconnect during cookie discovery aborts its response body', { timeout: 2000 }, async t => {
  const controller = new AbortController();
  let signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal;
    return stalledBody(t, signal);
  });
  const pending = fetchTTWID(1000, undefined, undefined, { signal: controller.signal, attempts: 1 });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('cookie retry waits are abortable and do not start another request', { timeout: 2000 }, async t => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(''); });
  const pending = fetchTTWID(1000, undefined, undefined, { signal: controller.signal, attempts: 3, retryDelayMs: 20 });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('canceling one discovery does not cancel another client', async t => {
  const requests = new Map();
  const sessions = [];
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
    const name = new URL(url).searchParams.get('uniqueId');
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    requests.set(name, () => { signal.removeEventListener('abort', abort); resolve(new Response(online)); });
  }));
  class Client extends TikTokLiveClient {
    runSessions(roomId) { sessions.push(this.username); return Promise.resolve(roomId); }
  }
  const alice = new Client('alice'), bob = new Client('bob');
  const a = alice.connect(), b = bob.connect();
  a.catch(() => {}); b.catch(() => {});
  t.after(() => { alice.disconnect(); bob.disconnect(); for (const release of requests.values()) release(); });
  alice.disconnect();
  for (const release of requests.values()) release();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(await b, '123');
  assert.deepEqual(sessions, ['bob']);
});

test('the session remains cancelable after the first handshake resolves connect', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(online));
  let sessionSignal;
  class Client extends TikTokLiveClient {
    runSessions(roomId, _makeDeps, controller) {
      return super.runSessions(roomId, signal => ({
        newSession: async () => ({}),
        runSession: (_session, onOpen) => new Promise(resolve => {
          sessionSignal = signal;
          signal.addEventListener('abort', resolve, { once: true });
          onOpen();
        }),
        sleep: async () => {}, now: Date.now,
      }), controller);
    }
  }
  const client = new Client('alice');
  t.after(() => client.disconnect());
  assert.equal(await client.connect(), '123');
  const closed = once(client, EventType.disconnected);
  client.disconnect();
  assert.equal(sessionSignal.aborted, true);
  await closed;
});
