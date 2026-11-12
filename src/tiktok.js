// Adapt one TikTok LIVE stream to the shared SSE contract.
// Game rules, gift tiers and chat throttling belong to clients.
// Inject a fake library to test without network access.
// No callbacks are delivered after disconnect().
import * as piratetok from 'piratetok-live-js';
import { normalizeEvent } from './events.js';

export function startTikTok(name, handlers, lib = piratetok) {
  const { onGift, onChat, onLike, onFollow, onShare, onJoin, onViewers, onStatus, onOpen, onFail, onLost } = handlers;
  let client;
  try { client = new lib.TikTokLiveClient(name); }
  catch (err) {
    onFail(`Could not initialize the connection to @${name}: ${err.message}.`);
    return { disconnect() {} };
  }
  const E = lib.EventType;
  let closed = false, linked = false; // linked: the first WSS handshake succeeded
  const live = fn => (...args) => { if (!closed) fn(...args); };

  function forward(source, type, handler) {
    client.on(source, live(data => {
      const event = normalizeEvent(type, data);
      if (event) handler?.(event);
    }));
  }
  forward(E.gift, 'gift', onGift); // Only emit the final combo total.
  forward(E.chat, 'chat', onChat);
  forward(E.like, 'like', onLike);
  forward(E.follow, 'follow', onFollow);
  forward(E.share, 'share', onShare);
  forward(E.join, 'join', onJoin);
  forward(E.roomUserSeq, 'viewers', onViewers);
  client.on(E.liveEnded, live(() => onStatus(`@${name} has ended the live stream.`)));
  client.on(E.reconnecting, live(() => onStatus(`Reconnecting to @${name}...`)));
  // A rejected connect() can also emit disconnected; onFail already handles that case.
  client.on(E.disconnected, live(() => { if (linked) onLost('Connection lost.'); }));
  client.on('error', live(err => console.log(`[@${name}] piratetok error:`, JSON.stringify(String(err?.message || err)))));

  onStatus(`Connecting to @${name} (piratetok-live-js)...`);
  client.connect()
    .then(roomId => {
      if (closed) { try { client.disconnect(); } catch {} return; } // Close a connection that completed after cancellation.
      linked = true;
      onOpen(roomId);
      onStatus(`Connected to @${name} (room ${roomId}). Waiting for events...`);
    })
    .catch(err => { if (!closed) onFail(`Could not connect to @${name}: ${err?.message || err}.`); });

  return { disconnect() { closed = true; try { client.disconnect(); } catch {} } };
}
