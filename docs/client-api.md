# Client API Reference

[README](../README.md) · [Integration guide](client-guide.md) · [Deployment](deployment.md)

## 1. Base URL and transport

Local base URL: `http://127.0.0.1:3100`. Use your backend's HTTPS URL when integrating a deployed website.

This API uses **HTTP Server-Sent Events**, not a WebSocket endpoint. One SSE request subscribes to one TikTok username. Multiple clients can share a username without opening additional TikTok connections.

There is no built-in authentication. CORS controls browser access only; non-browser callers can omit the `Origin` header.

## 2. Endpoints

### GET /

Returns HTTP 200 and a plain-text process-reachability message:

```text
TikTok LIVE backend is running. Use /events?username=your_username
```

This is not a TikTok connectivity or readiness check.

### GET /healthz

Exact, query-free process liveness endpoint for hosting probes. GET returns HTTP 200, `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store`, and `ok` followed by a newline. HEAD returns the same status/headers without a body. Other methods return 405 with `Allow: GET, HEAD`; request bodies are rejected with 400.

This endpoint bypasses CORS and application request/stream admission quotas, exposes no room or user data, and never contacts TikTok. HTTP header-size/count protections still apply. It does not prove upstream connectivity, LIVE availability or delivery completeness. It intentionally has no Access-Control-Allow-Origin header; browser clients should subscribe to `/events` instead.

### GET /events?username=your_username

Opens a persistent event stream. `username` is required.

Username normalization trims surrounding whitespace and removes one leading `@`. The remaining value must match `^[A-Za-z0-9._]{1,40}$`. It is **not lowercased**. Use consistent casing across clients to share the same room. `@alice` and `alice` share a room; `Alice` and `alice` are separate backend keys.

Successful response:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

The first frame tells browser EventSource clients to retry after 3 seconds:

```text
retry: 3000

```

Subsequent frames contain a named event and one JSON payload:

```text
event: status
data: {"text":"Connecting to @alice (piratetok-live-js)..."}

```

Every frame ends with a blank line. HTTP chunks are not frame boundaries: a chunk may contain a partial frame or multiple frames.

All payloads use **named events**. Browser clients must use `addEventListener('chat', ...)`, etc.; `source.onmessage` alone will not receive them. The server sends a `: heartbeat` comment every 15 seconds; a standard EventSource ignores these comments. It does not emit SSE `id:` fields or historical replay. A frame over 64 KiB is omitted; a client whose pending Node response bytes would exceed 256 KiB is disconnected.

### HTTP response codes

| Code | Meaning |
|---|---|
| `200` | SSE stream opened, root/liveness check succeeded, or simulation accepted |
| `204` | Allowed OPTIONS request on `/events` or an enabled simulation route |
| `400` | Invalid/missing stream username, invalid supplied simulation number, or nonpositive simulated diamonds |
| `403` | Disallowed Origin, or a cross-site simulation request |
| `404` | Unknown path, including a simulation route when simulation is disabled |
| `405` | Unsupported method; HEAD is not allowed on stream/simulation routes |
| `414` | Request URL exceeds 4096 bytes |
| `429` | Per-IP request/stream limit, global request limit or IP-tracking capacity reached |
| `431` | Header bytes/count exceeds the HTTP limit |
| `503` | A new username exceeds 10 rooms, or total SSE client capacity is reached |

Validation errors use plain text, not a JSON error schema. Some 403/404 responses have no body. After SSE HTTP 200 has been sent, TikTok connection failures are reported as `status` events, not a later HTTP error code.

OPTIONS is handled before stream username validation and does not create a room, but still consumes a request quota. Use GET for subscriptions and simulations; HEAD is allowed for the root and `/healthz` checks, and unsupported methods return 405. Request bodies are rejected. Limit responses include Retry-After in seconds; see [all limits and proxy identity rules](security.md). The HTTP body remains an indefinite stream after a successful subscription, not a 15-second request.

## 3. Common payload rules

### Metadata

All seven data events have these fields. `status` is the exception.

| Field | Type | Meaning |
|---|---|---|
| `eventId` | string | TikTok `common.msgId`, or `""` when unavailable |
| `roomId` | string | TikTok `common.roomId`, or `""` when unavailable |
| `ts` | number | Backend processing time in Unix **milliseconds**, not the original TikTok event time |

IDs stay as strings to preserve 64-bit values. Do not use `Number(eventId)` or `Number(user.id)`. Unsafe numeric IDs received by the normalizer are discarded rather than converted to an inaccurate identifier.

The backend does not synthesize event IDs, infer missing room IDs, deduplicate messages or store events. `eventId` helps a client identify duplicates when present; it does not guarantee exactly-once delivery. See the [deduplication guidance](client-guide.md#deduplication-and-counting).

### User

`chat`, `gift`, `like`, `follow`, `share` and `join` contain a `user` object with these always-present fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Account ID, or `""` |
| `nickname` | string | Display name, or `""`; not unique |
| `uniqueId` | string | TikTok username, or `""` |
| `avatarUrl` | string | Preferred display URL: thumb, then medium, then large; or `""` |
| `avatarThumb` | string | First valid HTTP(S) URL in avatarThumb.urlList, or `""` |
| `avatarMedium` | string | First valid HTTP(S) URL in avatarMedium.urlList, or `""` |
| `avatarLarge` | string | First valid HTTP(S) URL in avatarLarge.urlList, or `""` |

No profile lookup fills missing fields. Image URLs can expire, fail to load or use HTTP. HTTPS pages may block HTTP images as mixed content. Use a visual fallback and treat all incoming text as untrusted.

### Numbers and missing fields

Counters are nonnegative safe JavaScript integers or `null`. Missing, malformed, negative, fractional and unsafe values become `null`. Actual zero values remain `0`; do not use `value || fallback` when displaying counters.

Strings are `""` when unavailable. A gift's `repeatCount` is the exception to unknown counters: it defaults to at least 1, following the library's gift-quantity convention.

## 4. Event payloads

The following complete examples show the JSON in each SSE `data:` field. IDs and image URLs are illustrative, not real assets.

### status

```json
{
  "text": "Connected to @alice (room 7390000000000000003). Waiting for events..."
}
```

Human-readable connection progress, reconnect attempts, stream-end notices or failures. It has no metadata or `user`. Text is **not** a stable machine-readable state enum; display it rather than branching on exact sentences. A status may be repeated when a client joins.

### chat

```json
{
  "eventId": "7390000000000000101",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "user": {
    "id": "7390000000000000001",
    "nickname": "Alice",
    "uniqueId": "alice",
    "avatarUrl": "https://example.com/alice.jpg",
    "avatarThumb": "https://example.com/alice.jpg",
    "avatarMedium": "",
    "avatarLarge": ""
  },
  "text": "Hello!"
}
```

One received comment. `text` is an unmodified string from the message, or `""` when unavailable. The backend applies no game-specific filtering or throttling.

### gift

```json
{
  "eventId": "7390000000000000102",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "user": {
    "id": "7390000000000000001",
    "nickname": "Alice",
    "uniqueId": "alice",
    "avatarUrl": "https://example.com/alice.jpg",
    "avatarThumb": "https://example.com/alice.jpg",
    "avatarMedium": "",
    "avatarLarge": ""
  },
  "gift": "Rose",
  "diamonds": 10,
  "giftId": "5655",
  "giftImageUrl": "https://example.com/rose.jpg",
  "diamondCount": 2,
  "repeatCount": 5,
  "comboId": "7390000000000000004",
  "isCombo": true,
  "isStreakOver": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `gift` | string | Gift name; remains a string for existing clients |
| `diamonds` | number | Positive safe integer: total diamonds for the completed gift/combo |
| `giftId` | string | Gift catalog ID, or `""` |
| `giftImageUrl` | string | First valid HTTP(S) gift.image URL, falling back to gift.icon; or `""` |
| `diamondCount` | number or null | Diamonds per gift, when available |
| `repeatCount` | number | Quantity, at least 1 |
| `comboId` | string | Message groupId, or `""`; useful as additional combo context |
| `isCombo` | boolean | Whether the library classifies the gift as streakable |
| `isStreakOver` | true | Always true for emitted gifts |

The library calculates live `diamonds` as per-gift diamonds multiplied by quantity. The backend emits **only completed combos** with a valid positive total. Intermediate combo updates, zero-diamond gifts and gifts with invalid totals are omitted. A non-combo gift is already final.

**Add `diamonds` once per accepted gift event. Do not multiply it by `repeatCount` again.** Do not use `giftId` alone as a deduplication key: different people can send the same gift many times. Simulation accepts `diamonds` independently and does not enforce that it matches `diamondCount * repeatCount`.

### like

```json
{
  "eventId": "7390000000000000103",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "user": {
    "id": "7390000000000000001",
    "nickname": "Alice",
    "uniqueId": "alice",
    "avatarUrl": "https://example.com/alice.jpg",
    "avatarThumb": "https://example.com/alice.jpg",
    "avatarMedium": "",
    "avatarLarge": ""
  },
  "count": 3,
  "total": 100
}
```

`count` is the number of likes represented by this message; TikTok can batch multiple likes. `total` is TikTok's reported total. Either may be `null`. Neither the backend nor its client contract guarantees a monotonically increasing total.

### follow

```json
{
  "eventId": "7390000000000000104",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "user": {
    "id": "7390000000000000001",
    "nickname": "Alice",
    "uniqueId": "alice",
    "avatarUrl": "https://example.com/alice.jpg",
    "avatarThumb": "https://example.com/alice.jpg",
    "avatarMedium": "",
    "avatarLarge": ""
  },
  "followCount": 1
}
```

A follow event derived by the library from a TikTok social message. `followCount` is that message's counter, or `null`. Do not assume it is the account's total followers or a verified aggregate over your session.

### share

```json
{
  "eventId": "7390000000000000105",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "user": {
    "id": "7390000000000000001",
    "nickname": "Alice",
    "uniqueId": "alice",
    "avatarUrl": "https://example.com/alice.jpg",
    "avatarThumb": "https://example.com/alice.jpg",
    "avatarMedium": "",
    "avatarLarge": ""
  },
  "count": 1,
  "target": "link"
}
```

`count` comes from shareCount and may be `null`. `target` comes from shareTarget and may be `""`; it is not a guaranteed fixed enum or a URL that should be opened.

### join

```json
{
  "eventId": "7390000000000000106",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "user": {
    "id": "7390000000000000001",
    "nickname": "Alice",
    "uniqueId": "alice",
    "avatarUrl": "https://example.com/alice.jpg",
    "avatarThumb": "https://example.com/alice.jpg",
    "avatarMedium": "",
    "avatarLarge": ""
  },
  "memberCount": 20
}
```

An entry event derived by the library from a member message. `memberCount` is the count in that message, or `null`. It is not a complete audience roster. Use `viewers` for explicit viewer-count updates.

### viewers

```json
{
  "eventId": "7390000000000000107",
  "roomId": "7390000000000000003",
  "ts": 1731400000000,
  "viewerCount": 20,
  "totalUser": 300
}
```

`viewerCount` is TikTok's reported current viewer count; `totalUser` is its reported cumulative audience value. Both may be `null`. These values come directly from roomUserSeq messages and are not computed from joins. This event has **no `user`** and does not list individual viewers.

## 5. TypeScript reference

Copy these types into a TypeScript client if useful. They describe payloads, not an installed SDK or runtime validator. Clients should tolerate additional fields in future versions.

```ts
interface EventMeta {
  eventId: string;
  roomId: string;
  ts: number;
}
interface LiveUser {
  id: string;
  nickname: string;
  uniqueId: string;
  avatarUrl: string;
  avatarThumb: string;
  avatarMedium: string;
  avatarLarge: string;
}
interface UserEvent extends EventMeta {
  user: LiveUser;
}
interface GiftEvent extends UserEvent {
  gift: string;
  diamonds: number;
  giftId: string;
  giftImageUrl: string;
  diamondCount: number | null;
  repeatCount: number;
  comboId: string;
  isCombo: boolean;
  isStreakOver: true;
}
interface LiveEventMap {
  status: { text: string };
  chat: UserEvent & { text: string };
  gift: GiftEvent;
  like: UserEvent & { count: number | null; total: number | null };
  follow: UserEvent & { followCount: number | null };
  share: UserEvent & { count: number | null; target: string };
  join: UserEvent & { memberCount: number | null };
  viewers: EventMeta & { viewerCount: number | null; totalUser: number | null };
}
type LiveEvent = {
  [K in keyof LiveEventMap]: { type: K; data: LiveEventMap[K] }
}[keyof LiveEventMap];
```

The SSE event name supplies the event type. Payload JSON does **not** contain a `type` field; the `LiveEvent` union wraps the parsed payload on the client side.

## 6. Simulation endpoints

Set `TEST_GIFTS=1` **before starting the server**. The legacy variable name enables all seven simulation routes, not just gifts.

| GET route | Specific query parameters |
|---|---|
| `/chat` | `text` |
| `/gift` | `gift`, `diamonds`, `giftId`, `giftImage`, `diamondCount`, `repeatCount`, `comboId` |
| `/like` | `count`, `total` |
| `/follow` | `followCount` |
| `/share` | `count`, `target` |
| `/join` | `memberCount` |
| `/viewers` | `viewerCount`, `totalUser` |

Shared parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `username` | All existing rooms | Target stream username; it does not create a room |
| `name` | `Guest` | User nickname |
| `uniqueId` | Same as name | User username |
| `userId` | `""` | User account ID |
| `avatar` | `""` | User thumbnail URL |
| `eventId` | `""` | Message ID |
| `roomId` | `""` | TikTok room ID; independent of target username |

Gift defaults: `gift=test`, `diamonds=1`, `repeatCount=1`, `giftId=""`, `giftImageUrl=""`, `comboId=""`, `diamondCount=null`. Simulation marks a gift as a combo when the supplied repeatCount is greater than 1 and always marks it complete. Other missing counters are `null`. Missing chat text and share target are `""`.

All supplied numeric parameters must contain digits only and fit a safe nonnegative integer. For gifts, `diamonds` must also be greater than 0. The normalizer clamps a zero `repeatCount` to 1. IDs are strings, not numeric query parameters.

Example:

```sh
curl --get 'http://127.0.0.1:3100/gift' \
  --data-urlencode 'username=alice' \
  --data-urlencode 'name=Alice' \
  --data-urlencode 'userId=7390000000000000001' \
  --data-urlencode 'avatar=https://example.com/alice.jpg' \
  --data-urlencode 'gift=Rose' \
  --data-urlencode 'giftId=5655' \
  --data-urlencode 'giftImage=https://example.com/rose.jpg' \
  --data-urlencode 'diamonds=10' \
  --data-urlencode 'diamondCount=2' \
  --data-urlencode 'repeatCount=5'
```

Success is plain text, for example `ok (rooms: 1)`. This counts **target rooms**, not clients, active TikTok connections or confirmed client receipt. A valid request with no existing target returns `ok (rooms: 0)` and is not queued for later delivery.

Simulation uses the same payload normalizer as live events. It requires an existing SSE room; opening `/events` on a normally configured server still tries to connect to TikTok, even with `TEST_GIFTS=1`. Offline automated tests inject a fake connector instead.

Simulation routes are disabled by default (404). Production mode refuses startup with TEST_GIFTS=1; use a private non-production development/test instance. Allowed origins are checked, and requests declaring `Sec-Fetch-Site: cross-site` are rejected. These checks are not authentication; keep simulation disabled on public servers and invoke local tests from a terminal when browser cross-site restrictions apply.

## 7. Compatibility and delivery limits

- `gift` remains a string, and `diamonds` remains the completed combo total. Added metadata and user/image fields do not replace legacy fields.
- Human-readable responses are now English. Do not parse status sentences, root text or simulation acknowledgement text as a stable machine protocol.
- An SSE reconnect subscribes again; it does not replay events missed during disconnection. `Last-Event-ID` is not implemented.
- TikTok's feed may omit, batch or repeat events. The backend provides no completeness, exact ordering across reconnects or exactly-once guarantee.
- Each process has its own in-memory rooms; multiple backend processes do not share connections or state.
- The backend is a raw event bridge, not a payments ledger, authoritative follower database or complete viewer tracking system.
