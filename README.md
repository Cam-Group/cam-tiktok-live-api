# TikTok LIVE Event Backend

A small, self-hosted Node.js backend that receives TikTok LIVE events and broadcasts them to games and apps over Server-Sent Events (SSE).

**Events:** `status`, `chat`, `gift`, `like`, `follow`, `share`, `join`, `viewers`.

User events include account IDs, display names, usernames and available avatar URLs. Gifts include gift images, IDs, quantities and diamond totals. Game rules and presentation stay in each client.

## Quick start

Requires **Node.js 22.19.0 or newer** and npm.

```sh
npm ci
npm start
```

By default, the native process listens on **`http://127.0.0.1:3100`**. It does not serve a frontend. Docker is optional; `npm start` continues to work without it.

Check that the process is reachable:

```sh
curl http://127.0.0.1:3100/
```

Subscribe to a TikTok username (replace `your_username` with an account that is LIVE):

```sh
curl -N 'http://127.0.0.1:3100/events?username=your_username'
```

In a browser client:

```js
const url = new URL('/events', 'http://127.0.0.1:3100');
url.searchParams.set('username', 'your_username');
const source = new EventSource(url);

source.addEventListener('status', message => {
  console.log('TikTok status:', JSON.parse(message.data).text);
});
source.addEventListener('chat', message => {
  const event = JSON.parse(message.data);
  console.log(event.user.nickname, event.text, event.user.avatarUrl);
});
source.addEventListener('gift', message => {
  const event = JSON.parse(message.data);
  console.log(event.user.nickname, event.gift, event.diamonds);
});

// Call source.close() when the screen or app no longer needs the stream.
```

`EventSource` connects to this backend, not to TikTok directly. A successful SSE connection does not mean TikTok has connected yet: check `status` messages.

## Documentation

| Document | Contents |
|---|---|
| [Client API reference](docs/client-api.md) | Endpoints, every event schema, payload examples, TypeScript types and simulation parameters |
| [Client integration guide](docs/client-guide.md) | Browser and React examples, avatars, deduplication, reconnects, native/Unity clients and local testing |
| [Deployment and troubleshooting](docs/deployment.md) | Configuration, HTTPS, reverse proxy example, CORS, capacity, security and common failures |
| [Public access and publish checklist](docs/security.md) | No-DB access model, exact limits, trusted proxies, abuse controls and remaining publish requirements |
| [Cloudflare Tunnel setup](docs/cloudflare.md) | Publish tiktok-live-api.vinhvu-cam.id.vn with a named tunnel, a private token file and correct visitor IP handling |

## Docker: ready for a Linux move

With a running Docker daemon and Docker Compose:

```sh
docker compose up -d --build
curl http://127.0.0.1:3100/
docker compose logs -f backend
```

The image runs as a non-root user. It listens on all container interfaces, but Compose publishes the port **only on the host's loopback interface**. Simulation stays disabled. No database, host node_modules or data volume is required. Use the same project files on macOS or Linux; build on the target machine to use its architecture.

See [Docker deployment and migration instructions](docs/deployment.md#docker-compose-on-macos-or-linux) for configuration, updates, stopping and moving to another machine. Docker does not publish an HTTPS URL or add authentication by itself.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3100` | Native HTTP port; with Compose, the published host port (container port stays 3100) |
| `HOST` | `127.0.0.1` | Native bind address; the Docker image sets `0.0.0.0` inside the container |
| `ALLOWED_ORIGINS` | Empty | Comma-separated browser origin allowlist; empty allows every origin |
| `TEST_GIFTS` | Disabled | Set exactly to `1` to enable simulation endpoints for all seven data events |

[.env.example](.env.example) documents Compose settings; copy it to a local `.env` only if you do not already have deployment settings, then edit the origin/proxy values. Native npm start does not automatically read either file.

For example:

```sh
PORT=3100 ALLOWED_ORIGINS=https://game.example npm start
```

**Access is intentionally public, not authenticated.** Anyone can select a valid LIVE username within resource limits. No database, browser API secret or login is required. Defaults are 100 SSE clients/process, 5/IP, 60 HTTP requests/minute/IP and 600/process, plus the existing 10-room cap. Limits are in RAM and reset on restart. CORS is not authentication. See the [full limit table and publish checklist](docs/security.md); these defaults are not measured throughput guarantees.

Behind a proxy, configure `TRUSTED_PROXIES` with exact controlled peer IPs and overwrite X-Forwarded-For correctly. Forwarded headers are ignored by default; otherwise all visitors may share the proxy's quota. Keep simulation disabled in production.

## How it works

```text
TikTok HTTPS: resolve room and obtain an anonymous ttwid cookie
    -> TikTok WebSocket: receive compressed Protobuf messages
    -> piratetok-live-js: decode messages
    -> src/events.js: normalize the client payload
    -> HTTP SSE: broadcast to clients subscribed to that username
```

The installed `piratetok-live-js@0.3.0` code runs locally. The current connection path uses TikTok endpoints, not a PirateTok API/signing service. No proxy or login cookies are configured. Avatar and gift URLs come from the incoming messages; the backend does not fetch or store those images.

This is an **unofficial TikTok protocol**, not a supported TikTok developer API. TikTok can block connections or change its protocol. The library can also contain bugs or require maintenance. No claim of complete or uninterrupted event delivery is made.

Clients with the same normalized username share one TikTok connection. Up to **10 usernames** can be monitored per process; empty rooms remain for a **10-second grace period**. Usernames are not lowercased, so clients should use consistent casing.

## Development

```sh
npm test
```

Tests run offline using fake connections, synthetic Protobuf packets through the real library decoder, and local HTTP/SSE requests. They cover payload normalization, avatar fallback, exact IDs, gift combos, disconnect behavior, room isolation, simulation and CORS. They do not validate a real TikTok LIVE session.

```text
Dockerfile            Non-root Linux image and process-reachability healthcheck
compose.yaml          Loopback-only host publishing, restart policy and log rotation
.dockerignore         Allowlisted build inputs; excludes dependencies and runtime history
server.js             HTTP routes, room lifecycle and SSE broadcasting
src/tiktok.js         TikTok library adapter and connection callbacks
src/events.js         Shared live/simulated event payload contract
src/access.js         Bounded in-memory request/stream quotas and trusted proxy identity
src/sse.js            Bounded SSE frame encoding and slow-client disconnection
test/                 Offline tests
docs/                 Client and deployment documentation
```

Project-maintained code, messages, tests and documentation use English. Incoming TikTok content is preserved in its original language. The English migration changes human-readable status/error text and the simulated default name to `Guest`; endpoint names, event names, field names and environment variables are unchanged.
