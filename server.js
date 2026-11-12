// Shared TikTok LIVE backend; game rules belong to clients.
// npm start -> http://localhost:3100/events?username=your_username
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { startTikTok } from './src/tiktok.js';
import { normalizeEvent } from './src/events.js';
import { createAccessControl } from './src/access.js';
import { send, emit, writeFrame, HEARTBEAT_MS } from './src/sse.js';

const RETRY_FAST_MS = 3000, RETRY_MS = 30000; // First two backend retries: 3 seconds; later retries: 30 seconds.
const GRACE_MS = 10000;                       // Keep the TikTok connection alive during quick page reloads.
const MAX_ROOMS = 10;
const USER_RE = /^[A-Za-z0-9._]{1,40}$/;
const EVENTS = ['gift', 'chat', 'like', 'follow', 'share', 'join', 'viewers'];
const TEXT = { 'Content-Type': 'text/plain; charset=utf-8' };
const cleanName = raw => (raw || '').trim().replace(/^@/, '');


// Inject a fake connector for offline HTTP/SSE tests.
export function createBackend(connectTikTok = startTikTok) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const origin of allowed) {
    let valid = false;
    try { const url = new URL(origin); valid = ['http:', 'https:'].includes(url.protocol) && url.origin === origin; } catch {}
    if (!valid) throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths');
  }
  const testEvents = process.env.TEST_GIFTS === '1';
  if (testEvents && process.env.NODE_ENV === 'production') throw new Error('TEST_GIFTS cannot be enabled in production');
  const access = createAccessControl();
  const rooms = new Map();
  let heartbeat;
  function rejectLimit(res, limit) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.writeHead(limit.status, TEXT).end(`${limit.message}\n`);
  }

  function setStatus(room, text) {
    room.status = text;
    emit(room, 'status', { text });
    console.log(`[@${room.name}] ${JSON.stringify(text)}`);
  }

  function retry(room, why) {
    room.fails++;
    const wait = room.fails <= 2 ? RETRY_FAST_MS : RETRY_MS;
    clearTimeout(room.retryTimer);
    room.retryTimer = setTimeout(() => connect(room), wait);
    setStatus(room, `${why} Retrying in ${wait / 1000}s.`);
  }

  function connect(room) {
    clearTimeout(room.retryTimer);
    const old = room.conn;
    room.conn = null;
    try { old?.disconnect(); } catch {}
    const handlers = Object.fromEntries(EVENTS.map(event => [
      `on${event[0].toUpperCase()}${event.slice(1)}`,
      data => emit(room, event, data),
    ]));
    room.conn = connectTikTok(room.name, {
      ...handlers,
      onStatus: text => setStatus(room, text),
      onOpen: () => { room.fails = 0; },
      onFail: why => retry(room, why),
      onLost: why => retry(room, why),
    });
  }

  function join(name, res) {
    let room = rooms.get(name);
    if (!room) {
      room = { name, clients: new Set(), conn: null, status: '', fails: 0, retryTimer: null, graceTimer: null };
      rooms.set(name, room);
      room.clients.add(res);
      connect(room);
    } else {
      clearTimeout(room.graceTimer);
      room.clients.add(res);
    }
    send(res, 'status', { text: room.status });
    return room;
  }

  function leave(room, res) {
    room.clients.delete(res);
    if (room.clients.size || rooms.get(room.name) !== room) return;
    clearTimeout(room.graceTimer);
    room.graceTimer = setTimeout(() => {
      if (room.clients.size) return;
      clearTimeout(room.retryTimer);
      const old = room.conn;
      room.conn = null;
      try { old?.disconnect(); } catch {}
      rooms.delete(room.name);
      console.log(`[@${room.name}] No clients remaining; disconnected.`);
    }, GRACE_MS);
  }

  function allowCors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (origin && allowed.length && !allowed.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin && allowed.length ? origin : '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    return true;
  }

  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.rawHeaders.length > 64) return res.writeHead(431, TEXT).end('Too many request headers\n');
    const corsAllowed = allowCors(req, res);
    const ip = access.clientIp(req);
    if (!ip) return res.writeHead(400, TEXT).end('Invalid forwarded client IP\n');
    const limited = access.request(ip);
    if (limited) return rejectLimit(res, limited);
    if (!corsAllowed) return res.writeHead(403).end();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.writeHead(405, { ...TEXT, Allow: 'GET, HEAD, OPTIONS' }).end('Method not allowed\n');
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) {
      return res.writeHead(400, { ...TEXT, Connection: 'close' }).end('Request bodies are not supported\n');
    }
    if (Buffer.byteLength(req.url) > 4096) return res.writeHead(414, TEXT).end('Request URL too long\n');
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return res.writeHead(400, TEXT).end('Invalid request URL\n'); }
    if (url.pathname === '/events') {
      if (req.method === 'HEAD') return res.writeHead(405, { Allow: 'GET, OPTIONS' }).end();
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const name = cleanName(url.searchParams.get('username'));
      if (!USER_RE.test(name)) return res.writeHead(400, TEXT).end('Invalid username\n');
      if (!rooms.has(name) && rooms.size >= MAX_ROOMS) return res.writeHead(503, TEXT).end('Too many usernames being monitored\n');
      const lease = access.open(ip);
      if (lease.status) return rejectLimit(res, lease);
      let room;
      res.once('close', () => { lease.release(); if (room) leave(room, res); });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      writeFrame(res, 'retry: 3000\n\n');
      room = join(name, res);
    } else if (testEvents && EVENTS.some(event => url.pathname === `/${event}`)) {
      if (req.method === 'HEAD') return res.writeHead(405, { Allow: 'GET, OPTIONS' }).end();
      if (req.headers['sec-fetch-site'] === 'cross-site') return res.writeHead(403).end();
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      const params = url.searchParams;
      const type = url.pathname.slice(1);
      const name = cleanName(params.get('username'));
      if (name && !USER_RE.test(name)) return res.writeHead(400, TEXT).end('Invalid username\n');
      const targets = name ? [rooms.get(name)].filter(Boolean) : [...rooms.values()];
      const who = params.get('name') || 'Guest';
      const numeric = ['diamonds', 'diamondCount', 'repeatCount', 'count', 'total', 'followCount', 'memberCount', 'viewerCount', 'totalUser'];
      for (const key of numeric) {
        if (params.has(key) && (!/^\d+$/.test(params.get(key)) || !Number.isSafeInteger(Number(params.get(key))))) {
          return res.writeHead(400, TEXT).end(`Invalid ${key}\n`);
        }
      }
      const data = normalizeEvent(type, {
        common: { msgId: params.get('eventId'), roomId: params.get('roomId') },
        user: { id: params.get('userId'), nickname: who, uniqueId: params.get('uniqueId') || who, avatarThumb: { urlList: [params.get('avatar')] } },
        content: params.get('text') || '',
        isStreakOver: true,
        isCombo: Number(params.get('repeatCount')) > 1,
        diamondTotal: params.get('diamonds') || '1',
        giftId: params.get('giftId'),
        gift: { name: params.get('gift') || 'test', image: { urlList: [params.get('giftImage')] }, diamondCount: params.get('diamondCount') },
        repeatCount: params.get('repeatCount'),
        groupId: params.get('comboId'),
        count: params.get('count'), total: params.get('total'),
        followCount: params.get('followCount'),
        shareCount: params.get('count'), shareTarget: params.get('target'),
        memberCount: params.get('memberCount'),
        viewerCount: params.get('viewerCount'), totalUser: params.get('totalUser'),
      });
      if (!data) return res.writeHead(400, TEXT).end('Gift diamonds must be greater than 0\n');
      targets.forEach(room => emit(room, type, data));
      res.writeHead(200, TEXT).end(`ok (rooms: ${targets.length})\n`);
    } else if (url.pathname === '/') {
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      res.writeHead(200, TEXT).end('TikTok LIVE backend is running. Use /events?username=your_username\n');
    } else res.writeHead(404).end();
  });
  server.maxConnections = access.maxClients + 100;
  server.maxHeadersCount = 32;
  server.on('listening', () => {
    heartbeat = setInterval(() => {
      for (const room of rooms.values()) for (const res of room.clients) writeFrame(res, ': heartbeat\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref();
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) {
      clearTimeout(room.retryTimer);
      clearTimeout(room.graceTimer);
      try { room.conn?.disconnect(); } catch {}
    }
    rooms.clear();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3100;
  const host = process.env.HOST || '127.0.0.1';
  createBackend().listen(port, host, () => console.log(`Backend listening on ${host}:${port}. SSE: /events?username=your_username`));
}
