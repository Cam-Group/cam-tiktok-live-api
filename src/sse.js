export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_PENDING_BYTES = 256 * 1024;
export const HEARTBEAT_MS = 15000;

export function eventFrame(event, data) {
  const frame = Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return frame.length <= MAX_FRAME_BYTES ? frame : null;
}

export function writeFrame(res, frame) {
  if (!frame || res.destroyed || res.writableEnded) return false;
  const bytes = Buffer.isBuffer(frame) ? frame.length : Buffer.byteLength(frame);
  if (res.writableLength + bytes > MAX_PENDING_BYTES) {
    res.destroy(); // A slow consumer must not grow an unbounded user-space queue.
    return false;
  }
  try { res.write(frame); return true; }
  catch { res.destroy(); return false; }
}

export function send(res, event, data) {
  return writeFrame(res, eventFrame(event, data));
}

export function emit(room, event, data) {
  const frame = eventFrame(event, data); // Share encoded bytes, not per-subscriber string conversion.
  if (frame) for (const res of room.clients) writeFrame(res, frame);
}
