import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessControl } from '../src/access.js';

const request = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

test('forwarded IPs are ignored unless the immediate peer is explicitly trusted', () => {
  const direct = createAccessControl({});
  assert.equal(direct.clientIp(request('::ffff:127.0.0.1', '192.0.2.1')), '127.0.0.1');
  const proxy = createAccessControl({ TRUSTED_PROXIES: '127.0.0.1, ::1' });
  assert.equal(proxy.clientIp(request('::ffff:127.0.0.1', '192.0.2.1')), '192.0.2.1');
  assert.equal(proxy.clientIp(request('::1', '2001:0db8::1')), '2001:db8::1');
  assert.equal(proxy.clientIp(request('198.51.100.1', '192.0.2.1')), '198.51.100.1');
  assert.equal(proxy.clientIp(request('127.0.0.1')), '127.0.0.1');
  for (const value of ['192.0.2.1, 10.0.0.1', 'bad', 'fe80::1%en0', ['192.0.2.1']]) {
    assert.equal(proxy.clientIp(request('127.0.0.1', value)), '');
  }
});

test('Cloudflare mode trusts only the connector peer and ignores spoofable X-Forwarded-For', () => {
  const access = createAccessControl({ TRUSTED_PROXIES: '127.0.0.1', CLIENT_IP_HEADER: 'cf-connecting-ip' });
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } };
  assert.equal(access.clientIp(req), '192.0.2.1');
  req.socket.remoteAddress = '198.51.100.2';
  assert.equal(access.clientIp(req), '198.51.100.2');
  req.socket.remoteAddress = '127.0.0.1';
  req.headers['cf-connecting-ip'] = '192.0.2.1, 198.51.100.1';
  assert.equal(access.clientIp(req), '');
  assert.throws(() => createAccessControl({ CLIENT_IP_HEADER: 'arbitrary-header' }), /CLIENT_IP_HEADER/);
});

test('limits and trusted proxy configuration fail closed on invalid values', () => {
  for (const key of ['MAX_CLIENTS', 'MAX_CLIENTS_PER_IP', 'REQUESTS_PER_MINUTE', 'GLOBAL_REQUESTS_PER_MINUTE']) {
    for (const value of ['0', '-1', '1.5', 'bad', '9007199254740992']) {
      assert.throws(() => createAccessControl({ [key]: value }), /positive safe integer/);
    }
  }
  assert.throws(() => createAccessControl({ TRUSTED_PROXIES: '127.0.0.0/8' }), /IP addresses/);
});

test('per-IP limits reset after a minute and rejected IP requests do not consume global admission quota', () => {
  let time = 0;
  const access = createAccessControl({ REQUESTS_PER_MINUTE: '2', GLOBAL_REQUESTS_PER_MINUTE: '3' }, () => time);
  assert.equal(access.request('192.0.2.1'), null);
  assert.equal(access.request('192.0.2.1'), null);
  assert.equal(access.request('192.0.2.1').status, 429);
  assert.equal(access.request('192.0.2.2'), null);
  assert.equal(access.request('192.0.2.3').message, 'Server request limit reached');
  time = 60000;
  assert.equal(access.request('192.0.2.1'), null);
});

test('stream leases enforce shared server capacity and idempotently release per-IP capacity', () => {
  const access = createAccessControl({ MAX_CLIENTS: '2', MAX_CLIENTS_PER_IP: '1' });
  const one = access.open('192.0.2.1');
  assert.equal(access.open('192.0.2.1').status, 429);
  const two = access.open('192.0.2.2');
  assert.equal(access.open('192.0.2.3').status, 503);
  one.release();
  one.release();
  const three = access.open('192.0.2.3');
  assert.equal(typeof three.release, 'function');
  assert.equal(access.open('192.0.2.4').status, 503);
  two.release();
  three.release();
});

test('IP tracking is bounded and expired inactive records can be reclaimed', () => {
  let time = 0;
  const access = createAccessControl({ GLOBAL_REQUESTS_PER_MINUTE: '10000' }, () => time);
  for (let i = 0; i < 4096; i++) assert.equal(access.request(`10.0.${Math.floor(i / 256)}.${i % 256}`), null);
  assert.equal(access.request('192.0.2.1').message, 'Client tracking capacity reached');
  time = 60000;
  assert.equal(access.request('192.0.2.1'), null);
});

test('active stream counts survive request-window expiry', () => {
  let time = 0;
  const access = createAccessControl({ MAX_CLIENTS_PER_IP: '1' }, () => time);
  const stream = access.open('192.0.2.1');
  time = 120000;
  access.request('192.0.2.1');
  assert.equal(access.open('192.0.2.1').status, 429);
  stream.release();
  assert.equal(typeof access.open('192.0.2.1').release, 'function');
});
