import { isIP } from 'node:net';

const WINDOW_MS = 60000;
const MAX_TRACKED_IPS = 4096;

function positiveInteger(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return Number(value);
}

function canonicalIp(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6 && !value.includes('%')) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return '';
}

export function createAccessControl(env = process.env, now = Date.now) {
  const maxClients = positiveInteger(env, 'MAX_CLIENTS', 100);
  const maxPerIp = positiveInteger(env, 'MAX_CLIENTS_PER_IP', 5);
  const perIpRate = positiveInteger(env, 'REQUESTS_PER_MINUTE', 60);
  const globalRate = positiveInteger(env, 'GLOBAL_REQUESTS_PER_MINUTE', 600);
  const ipHeader = env.CLIENT_IP_HEADER || 'x-forwarded-for';
  if (!['x-forwarded-for', 'cf-connecting-ip'].includes(ipHeader)) {
    throw new Error('CLIENT_IP_HEADER must be x-forwarded-for or cf-connecting-ip');
  }
  const trusted = new Set();
  for (const value of (env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const ip = canonicalIp(value);
    if (!ip) throw new Error('TRUSTED_PROXIES must contain IP addresses, not hostnames or CIDRs');
    trusted.add(ip);
  }
  const ips = new Map();
  let active = 0, nextSweep = 0;
  let globalWindow = { resetAt: 0, count: 0 };
  const limited = (message, retryAfter = 60, status = 429) => ({ status, message, retryAfter });

  function record(ip, time) {
    if (time >= nextSweep) {
      for (const [key, value] of ips) if (!value.active && time >= value.resetAt) ips.delete(key);
      nextSweep = time + WINDOW_MS;
    }
    let value = ips.get(ip);
    if (!value) {
      if (ips.size >= MAX_TRACKED_IPS) return null;
      value = { resetAt: time + WINDOW_MS, count: 0, active: 0 };
      ips.set(ip, value);
    }
    if (time >= value.resetAt) { value.resetAt = time + WINDOW_MS; value.count = 0; }
    return value;
  }

  return {
    maxClients,
    clientIp(req) {
      const peer = canonicalIp(req.socket.remoteAddress);
      if (!peer) return '';
      if (!trusted.has(peer)) return peer; // Never trust forwarded identity from arbitrary callers.
      const forwarded = req.headers[ipHeader];
      if (forwarded === undefined) return peer;
      // The trusted proxy must provide exactly one verified address in the selected header.
      return typeof forwarded === 'string' ? canonicalIp(forwarded.trim()) : '';
    },
    request(ip) {
      const time = now();
      if (time >= globalWindow.resetAt) globalWindow = { resetAt: time + WINDOW_MS, count: 0 };
      const value = record(ip, time);
      if (!value) return limited('Client tracking capacity reached');
      if (value.count >= perIpRate) return limited('IP request limit reached', Math.max(1, Math.ceil((value.resetAt - time) / 1000)));
      value.count++;
      if (globalWindow.count >= globalRate) return limited('Server request limit reached', Math.max(1, Math.ceil((globalWindow.resetAt - time) / 1000)));
      globalWindow.count++;
      return null;
    },
    open(ip) {
      const value = record(ip, now());
      if (!value) return limited('Client tracking capacity reached');
      if (value.active >= maxPerIp) return limited('IP stream limit reached');
      if (active >= maxClients) return limited('Server stream limit reached', 10, 503);
      value.active++;
      active++;
      let released = false;
      return { release() {
        if (released) return;
        released = true;
        value.active--;
        active--;
      } };
    },
  };
}
