import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createBackend } from '../server.js';

function configured(env, fn) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return fn(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function backend(t, env = {}) {
  const made = [], closed = new EventEmitter(), controllers = [];
  const server = configured({ NODE_ENV: 'test', TEST_GIFTS: '0', ALLOWED_ORIGINS: '', TRUSTED_PROXIES: '', ...env }, () => createBackend((name, handlers) => {
    made.push(name);
    handlers.onStatus('ready');
    return { disconnect() {} };
  }));
  server.on('request', (req, res) => {
    if (req.url.startsWith('/events') && res.statusCode === 200) res.once('close', () => closed.emit('stream'));
  });
  t.after(() => new Promise(resolve => {
    for (const controller of controllers) controller.abort();
    server.close(resolve);
    server.closeAllConnections();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path = '/', headers = {}) => fetch(base + path, { headers, signal: AbortSignal.timeout(3000) });
  const stream = async (ip = '192.0.2.1') => {
    const controller = new AbortController(); controllers.push(controller);
    return { controller, response: await fetch(`${base}/events?username=alice`, { headers: { 'X-Forwarded-For': ip }, signal: controller.signal }) };
  };
  return { server, base, get, stream, made, closed };
}

test('public streams are capped per IP and released when the response closes', { timeout: 5000 }, async t => {
  const fixture = await backend(t, { MAX_CLIENTS_PER_IP: '1' });
  const first = await fixture.stream();
  assert.equal(first.response.status, 200);
  const denied = await fixture.stream('192.0.2.2'); // Untrusted forwarded values cannot bypass the quota.
  assert.equal(denied.response.status, 429);
  assert.ok(Number(denied.response.headers.get('retry-after')) > 0);
  await denied.response.text();
  const closed = once(fixture.closed, 'stream');
  first.controller.abort();
  await closed;
  const next = await fixture.stream();
  assert.equal(next.response.status, 200);
  assert.deepEqual(fixture.made, ['alice']);
});

test('a trusted proxy gets per-client quotas while the total stream cap still applies', async t => {
  const fixture = await backend(t, { MAX_CLIENTS: '2', MAX_CLIENTS_PER_IP: '1', TRUSTED_PROXIES: '127.0.0.1' });
  assert.equal((await fixture.stream('192.0.2.1')).response.status, 200);
  assert.equal((await fixture.stream('192.0.2.2')).response.status, 200);
  const denied = await fixture.stream('192.0.2.3');
  assert.equal(denied.response.status, 503);
  await denied.response.text();
  const malformed = await fixture.get('/', { 'X-Forwarded-For': '192.0.2.1, 127.0.0.1' });
  assert.equal(malformed.status, 400); await malformed.text();
});

test('HTTP rate limiting returns 429 and Retry-After before new room creation', async t => {
  const fixture = await backend(t, { REQUESTS_PER_MINUTE: '2' });
  for (let i = 0; i < 2; i++) { const response = await fixture.get(); assert.equal(response.status, 200); await response.text(); }
  const denied = await fixture.get('/events?username=alice', { 'X-Forwarded-For': '192.0.2.10' });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('retry-after')) > 0);
  await denied.text();
  assert.deepEqual(fixture.made, []);
});

test('request methods, bodies, long URLs and headers are bounded without opening rooms', async t => {
  const fixture = await backend(t);
  const post = await fetch(`${fixture.base}/events?username=alice`, { method: 'POST' });
  assert.equal(post.status, 405); await post.text();
  const head = await fetch(`${fixture.base}/events?username=alice`, { method: 'HEAD' });
  assert.equal(head.status, 405);
  const long = await fixture.get('/' + 'x'.repeat(5000)); assert.equal(long.status, 414); await long.text();
  const headers = await fixture.get('/', { 'X-Oversized': 'x'.repeat(9000) }); assert.equal(headers.status, 431); await headers.text();
  const many = await fixture.get('/', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`X-Header-${i}`, '1'])));
  assert.equal(many.status, 431); await many.text();
  await new Promise((resolve, reject) => {
    const req = http.request(fixture.base + '/events?username=alice', { method: 'GET', headers: { 'Content-Length': '1' } }, res => {
      res.resume(); assert.equal(res.statusCode, 400); res.on('end', resolve);
    });
    req.on('error', reject); req.end('x');
  });
  const root = await fixture.get();
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.equal(root.headers.get('referrer-policy'), 'no-referrer');
  await root.text();
  assert.deepEqual(fixture.made, []);
});

test('SSE heartbeat is a comment and does not change named event payloads', { timeout: 5000 }, async t => {
  let tick;
  const nativeInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => {
    if (ms === 15000) { tick = fn; return { unref() {} }; }
    return nativeInterval(fn, ms, ...args);
  });
  const fixture = await backend(t);
  const { response } = await fixture.stream();
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: status\ndata: /);
  tick();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': heartbeat\n\n');
  await reader.cancel();
});

test('production simulation and malformed CORS configuration fail startup', () => {
  assert.throws(() => configured({ NODE_ENV: 'production', TEST_GIFTS: '1' }, () => createBackend()), /cannot be enabled in production/);
  for (const origin of ['*', 'https://game.example/path', 'not-an-origin']) {
    assert.throws(() => configured({ ALLOWED_ORIGINS: origin }, () => createBackend()), /exact HTTP\(S\) origins/);
  }
});
