export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_PENDING_BYTES = 256 * 1024;
export const HEARTBEAT_MS = 15000;

export function eventFrame(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return Buffer.byteLength(frame) <= MAX_FRAME_BYTES ? frame : null;
}

export function writeFrame(res, frame) {
  if (!frame || res.destroyed || res.writableEnded) return false;
  if (res.writableLength + Buffer.byteLength(frame) > MAX_PENDING_BYTES) {
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
  const frame = eventFrame(event, data); // Encode once, not once per subscriber.
  if (frame) for (const res of room.clients) writeFrame(res, frame);
}
