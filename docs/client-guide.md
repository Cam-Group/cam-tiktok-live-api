# Client Integration Guide

[README](../README.md) · [API reference](client-api.md) · [Deployment](deployment.md)

## Render deployment

For Render, follow the [Render deployment guide](render.md), enter the exact frontend origin in ALLOWED_ORIGINS, and use the assigned `https://<service>.onrender.com` URL as the backend base URL. The `/events` route and payloads are unchanged. Free-plan cold starts, proxy-shared quotas and restarts can interrupt a stream; preserve reconnect behavior and clean up old subscriptions. No replay is available for events missed during a gap.

## Choose your backend URL

- A client on the same computer can use `http://127.0.0.1:3100`.
- A deployed HTTPS website needs an accessible **HTTPS backend URL**. The backend is not deployed automatically with a Vercel frontend.
- `localhost` and `127.0.0.1` refer to the computer running the client. A remote player's localhost is not your backend machine.
- Native mode defaults to loopback; Docker Compose publishes only on the host's loopback interface by default. Put a tunnel or reverse proxy in front of it rather than assuming it is reachable on your LAN.

Set `ALLOWED_ORIGINS` to the exact website origins that will connect, including scheme and any non-default port. Do not include a URL path or trailing slash. See [deployment configuration](deployment.md#environment-variables).

## Browser JavaScript: receive every event

The browser's native `EventSource` handles SSE framing and automatic reconnects. Do not add a separate reconnect loop on top of it.

This complete subscription example has no framework or npm dependency:

```js
function subscribeToLive({ baseUrl, username, onEvent, onTransport }) {
  const url = new URL('/events', baseUrl);
  url.searchParams.set('username', username);
  const source = new EventSource(url);
  const types = ['status', 'chat', 'gift', 'like', 'follow', 'share', 'join', 'viewers'];

  source.onopen = () => onTransport('open');
  source.onerror = () => {
    onTransport(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  };
  for (const type of types) {
    source.addEventListener(type, message => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch (error) {
        console.error('Invalid event JSON:', type, error);
        return;
      }
      onEvent({ type, data });
    });
  }
  return () => {
    source.close();
    onTransport('closed');
  };
}

const stop = subscribeToLive({
  baseUrl: 'http://127.0.0.1:3100',
  username: 'your_username',
  onTransport: state => console.log('Backend transport:', state),
  onEvent: ({ type, data }) => {
    if (type === 'status') console.log('TikTok:', data.text);
    else if (type === 'chat') console.log(data.user.nickname, data.text);
    else if (type === 'gift') console.log(data.gift, data.diamonds);
    else if (type === 'viewers') console.log('Viewers:', data.viewerCount ?? 'Unknown');
    else console.log(type, data);
  },
});

// On route changes, screen disposal, or before subscribing to a new username:
// stop();
```

The base URL examples assume the API is mounted at the root. `new URL('/events', baseUrl)` intentionally replaces any path in baseUrl; a reverse proxy should expose `/events` accordingly.

### Two different connection states

1. **Browser -> backend:** native EventSource `open` / `error` and readyState describe the HTTP stream.
2. **Backend -> TikTok:** the backend sends human-readable `status` events about TikTok connection progress and failures.

An open browser stream does not mean the TikTok user is online. Conversely, a temporary TikTok reconnect can happen while the browser stream stays open. Do not create a new EventSource just because a TikTok status says reconnecting.

Browsers generally do not expose the HTTP response body or exact HTTP status in `EventSource.onerror`. Use DevTools or a terminal request to distinguish CORS, 400, 403 and 503 failures. An EventSource may enter CLOSED for terminal failures; correct the configuration and explicitly reconnect rather than assuming every failure is retried.

### LIVE end and a later session

Keep the SSE subscription open when a username ends a LIVE. The backend retires that session and retries with a fresh TikTok client, resolving the username's current room again instead of reusing the ended room ID. Offline responses keep the retry loop running: the first two backend retries wait 3 seconds each, then retries wait 30 seconds; a successful connection resets that backoff. No server restart or manual cache clearing is required for this lifecycle.

The installed library's internal transport reconnects are scoped to the originally resolved room ID. A `liveEnded` event therefore triggers backend-level reconnection even if no `disconnected` event follows. Late events from the retired session are ignored. Existing SSE clients stay subscribed, but events during an offline/reconnection gap are not replayed. TikTok availability and restrictions still apply.

### Lifecycle and capacity

Keep **one subscription per needed username per screen**, and reuse its parsed events within your client. Call `.close()` on teardown and when switching usernames. A forgotten stream keeps its backend room alive.

Multiple viewers of the same username share a TikTok connection on the backend, but still consume individual HTTP connections. The 10-room cap is separate from the default 100-stream process limit and 5-stream per-IP limit; these are resource policies, not measured throughput. HTTP request quotas also apply to reconnect attempts. On 429/503, back off instead of creating extra streams; EventSource errors may hide the HTTP status/header details. See [the complete limit table](security.md). Browsers and proxies may impose additional limits, especially with HTTP/1.1.

When the final client disconnects, the backend keeps the TikTok connection for 10 seconds. Reconnecting during that interval reuses the room. Empty rooms still count against the room limit until cleanup completes.

## React: subscribe and clean up with an effect

The following hook is self-contained. It exposes the latest message for display, not a durable event queue or game-state accumulator.

```js
import { useEffect, useState } from 'react';

export function useTikTokLive(baseUrl, username) {
  const [state, setState] = useState({
    transport: 'idle',
    status: '',
    lastEvent: null,
  });

  useEffect(() => {
    setState({ transport: 'idle', status: '', lastEvent: null });
    if (!username) return;

    const url = new URL('/events', baseUrl);
    url.searchParams.set('username', username);
    const source = new EventSource(url);
    setState({ transport: 'connecting', status: '', lastEvent: null });

    source.onopen = () => setState(previous => ({ ...previous, transport: 'open' }));
    source.onerror = () => setState(previous => ({
      ...previous,
      transport: source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
    }));
    for (const type of ['status', 'chat', 'gift', 'like', 'follow', 'share', 'join', 'viewers']) {
      source.addEventListener(type, message => {
        let data;
        try { data = JSON.parse(message.data); }
        catch (error) { console.error('Invalid event JSON:', error); return; }
        setState(previous => type === 'status'
          ? { ...previous, status: data.text }
          : { ...previous, lastEvent: { type, data } });
      });
    }
    return () => source.close();
  }, [baseUrl, username]);

  return state;
}
```

Use it with your backend URL and username; display `transport` and `status` separately. React development Strict Mode can subscribe, clean up and subscribe again. Proper effect cleanup and the backend grace period accommodate this.

For game logic, consume events directly in the subscription callback and update your authoritative client state there. Do not rely on a React effect watching `lastEvent` to process every message: rendering and state updates can be batched, so intermediate messages can be lost from that display-only approach. Bound visible chat/history lists to avoid unbounded UI memory.

## Avatars, gift images and text

- Use `event.user.avatarUrl` for a commenter's or gift sender's avatar.
- Use `event.giftImageUrl` for the gift image. `event.gift` is still the name, not an object.
- A missing URL is `""`. A nonempty URL is not proof the image is reachable or permanent.
- Provide a default image or initials, and handle image load errors. Image requests go from the client to the image host, not through this backend.
- Render nicknames, comments and status strings as text, never unescaped HTML. In React, normal text interpolation is appropriate; avoid `dangerouslySetInnerHTML`.

A safe DOM rendering example for incoming chat events:

```js
const list = document.createElement('ul');
document.body.append(list);
const source = new EventSource('http://127.0.0.1:3100/events?username=your_username');
source.addEventListener('chat', message => {
  const event = JSON.parse(message.data);
  const row = document.createElement('li');
  if (event.user.avatarUrl) {
    const avatar = document.createElement('img');
    avatar.alt = ''; // The adjacent text already identifies the sender.
    avatar.width = 32;
    avatar.height = 32;
    avatar.referrerPolicy = 'no-referrer';
    avatar.addEventListener('error', () => avatar.remove(), { once: true });
    avatar.src = event.user.avatarUrl;
    row.append(avatar);
  }
  const label = document.createElement('span');
  label.textContent = `${event.user.nickname || event.user.uniqueId || 'Guest'}: ${event.text}`;
  row.append(label);
  list.append(row);
  while (list.children.length > 100) list.firstElementChild.remove();
});
// Call source.close() and remove list when this UI is disposed.
```

Use account `user.id` as the preferred stable user key. If unavailable, `uniqueId` can be a display/session fallback, but usernames can change. Do not merge unrelated users based only on nickname, empty IDs or a generic `Guest` label.

## Deduplication and counting

The backend has no event store, replay, acknowledgement protocol or built-in deduplication. A browser reconnect can miss messages; the upstream feed can also repeat them. Applications must decide what duplicate/loss tolerance their features require.

For best-effort short-session deduplication, include the subscribed username, event type, roomId and nonempty eventId. Use bounded storage:

```js
function createDuplicateFilter(limit = 2000) {
  const seen = new Set();
  return (username, type, event) => {
    if (!event.eventId) return false; // Missing IDs cannot safely be deduplicated this way.
    const key = JSON.stringify([username, type, event.roomId, event.eventId]);
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value);
    return false;
  };
}

const isDuplicate = createDuplicateFilter();
// In a data-event callback:
// if (isDuplicate(username, type, data)) return;
```

This cache forgets old IDs, is not persistent, and cannot guarantee exactly-once processing. It does not recover missed events or make this feed suitable as a billing ledger.

Counting rules:

- **Gift points:** after accepting an event, add `diamonds` once. It already includes repeatCount. For example, 5 gifts at 2 diamonds yield `diamonds=10`, not 50.
- **Gift animation quantity:** use `repeatCount`; there are no intermediate gift-progress events in this contract.
- **Likes:** use `count` for the received batch, and `total` for TikTok's reported snapshot. Do not add total values together. Use `??` to preserve genuine zeros and handle unknown counts explicitly.
- **Viewers:** show viewerCount as the current snapshot, not a counter to increment. Keep totalUser separate. Missing values are unknown, not zero.
- **Follows/shares/joins:** these are received messages, not a complete audit log or authoritative account statistics. Keep any game-specific policy on the client.

## Native, Unity and other non-browser clients

Use an HTTP SSE client appropriate for your runtime. SSE heartbeat comments arrive every 15 seconds; ignore them as application data. Oversized events can be omitted and slow clients disconnected, so keep consumption responsive. Do not connect a WebSocket client to `/events`. CORS normally does not apply outside browsers, but network reachability and HTTPS validation still do.

A correct implementation must:

1. Send a GET request with a URL-encoded username and read the body incrementally instead of buffering until completion.
2. Decode UTF-8 incrementally; a multibyte character can cross HTTP chunk boundaries.
3. Accumulate SSE lines until a blank line, retaining incomplete data between reads. Process named `event:` fields, JSON `data:` fields, and the `retry:` hint.
4. Ignore SSE comments/unsupported fields as specified by the SSE protocol; do not assume each TCP/HTTP chunk is one JSON document.
5. Handle non-200 responses before parsing the stream. Reconnect with a bounded delay after transient failures and cancel both reads and retries when the screen/session is disposed.
6. Dispatch UI updates to your UI/game main thread when required. Keep any queue bounded under high traffic.
7. Preserve string IDs and distinguish null counters from zero.

Unity JSON libraries differ: some basic serializers do not model nullable numbers easily. Choose a JSON decoder that preserves `null` and 64-bit ID strings; do not silently coerce unknown counters to zero. Prefer a maintained SSE parser over writing one unless your runtime requires it.

## Test a client locally

Start a development backend:

```sh
NODE_ENV=development TEST_GIFTS=1 npm start
```

Open the stream in the client or a terminal, leaving it connected:

```sh
curl -N 'http://127.0.0.1:3100/events?username=alice'
```

In another terminal, emit samples:

```sh
curl --get 'http://127.0.0.1:3100/chat' --data-urlencode 'username=alice' --data-urlencode 'name=Alice' --data-urlencode 'text=Hello from a simulated event!'
curl 'http://127.0.0.1:3100/gift?username=alice&name=Alice&diamonds=10&diamondCount=2&repeatCount=5'
curl 'http://127.0.0.1:3100/like?username=alice&count=3&total=100'
curl 'http://127.0.0.1:3100/follow?username=alice&followCount=1'
curl 'http://127.0.0.1:3100/share?username=alice&count=1&target=link'
curl 'http://127.0.0.1:3100/join?username=alice&memberCount=20'
curl 'http://127.0.0.1:3100/viewers?username=alice&viewerCount=20&totalUser=300'
```

These requests do not require TikTok to have connected successfully, but they **do require an existing SSE room**. Normal `/events` subscriptions still attempt to contact TikTok. Acknowledgement `ok (rooms: 0)` means no target room exists, so reconnect the client first.

For images and metadata, use the [complete gift simulation example and parameter reference](client-api.md#6-simulation-endpoints). Use URLSearchParams or curl `--data-urlencode` for URLs, spaces, `&` characters and non-ASCII text. A browser-originated cross-site simulation call can be rejected even if SSE CORS is allowed; terminal curl is the simplest local simulation method.

Validate your client with missing user fields, empty image URLs, broken images, zero and null counters, duplicate IDs, a backend restart, username changes and screen teardown. Simulation is a UI/integration aid, not evidence that TikTok supplies every event in production.

For a fully offline backend test, run `npm test`. It uses an injected fake TikTok connector and makes no TikTok requests.
