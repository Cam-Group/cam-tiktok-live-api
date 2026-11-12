# Deployment and Troubleshooting

[README](../README.md) · [API reference](client-api.md) · [Integration guide](client-guide.md)

## Environment variables

| Variable | Default | Details |
|---|---|---|
| `PORT` | `3100` | Native HTTP port; with Compose, the published host port. Use a valid available TCP port. |
| `HOST` | `127.0.0.1` | Native bind address. The Docker image sets `0.0.0.0` so port forwarding can reach the container. |
| `ALLOWED_ORIGINS` | Empty | Comma-separated exact Origin values. Whitespace around each value is trimmed. Empty permits any browser origin. |
| `TEST_GIFTS` | Disabled | Only `1` enables simulation in non-production; production rejects this configuration. |
| `MAX_CLIENTS` | `100` | Concurrent SSE connections per process |
| `MAX_CLIENTS_PER_IP` | `5` | Concurrent SSE connections per resolved client IP |
| `REQUESTS_PER_MINUTE` | `60` | HTTP requests/IP per fixed 60-second window |
| `GLOBAL_REQUESTS_PER_MINUTE` | `600` | Admitted HTTP requests/process per fixed 60-second window |
| `TRUSTED_PROXIES` | Empty | Exact controlled immediate proxy IPs allowed to supply a verified visitor address |
| `CLIENT_IP_HEADER` | `x-forwarded-for` | Only x-forwarded-for or cf-connecting-ip; Cloudflare mode requires a controlled tunnel path |

Example for a deployed game and local development frontend:

```sh
PORT=3100 ALLOWED_ORIGINS=https://game.example,http://localhost:5173 npm start
```

An origin is scheme + hostname + optional port, with no path or trailing slash. `http://localhost:5173`, `http://127.0.0.1:5173` and `https://localhost:5173` are different origins. Configuration is read when a backend instance is created; restart the standalone server after changing environment variables.

The native Node process does not load `.env` files automatically. Set variables in your shell, process manager or hosting environment. Docker Compose can read its own `.env` file for interpolation, as described below. The server has no built-in token, login or cookie-based authentication.

## Native process on your current machine

```sh
npm ci
npm start
```

Docker is not required for this mode. The default HOST is `127.0.0.1`; changing it to `0.0.0.0` deliberately exposes the native listener on all IPv4 interfaces. Keep the default when using a local HTTPS proxy or tunnel. Use a suitable process manager for unattended native deployments. The machine must stay awake and connected to the network.

Do not run native and Docker instances on the same host port at the same time. Stop one first or use a different PORT.

## Docker Compose on macOS or Linux

Prerequisites: a running Docker daemon and the Docker Compose plugin. Docker Desktop provides these on macOS; a Linux host can use Docker Engine plus Compose. Verify the installation before deploying:

```sh
docker version
docker compose version
```

Before the first start, create or update a local `.env` file next to compose.yaml with the deployment's settings:

```dotenv
PORT=3100
ALLOWED_ORIGINS=https://game.example
```

Compose reads this file for variable interpolation; npm start does not. Preserve the file across updates so later Compose commands use the same port and allowlist. The repository ignores `.env`, and the Docker build-context allowlist excludes it. Do not store credentials in ALLOWED_ORIGINS.

Start from the project directory:

```sh
docker compose up -d --build
curl http://127.0.0.1:3100/
docker compose ps
docker compose logs -f backend
```

This starts a single backend process. Ctrl+C exits the log viewer without stopping the detached service. The image is based on Node.js 24 on Debian Linux and installs exactly the lockfile dependencies with lifecycle scripts disabled. The application runs as the unprivileged `node` user; the init process forwards shutdown signals and reaps child processes.

### Network and configuration defaults

- **Container:** the image sets `HOST=0.0.0.0` and `PORT=3100`. Listening only on 127.0.0.1 inside a container would prevent normal Docker port forwarding from reaching it.
- **Host:** Compose publishes `127.0.0.1:3100:3100`, not every public interface. A proxy/tunnel running on the host can forward to `http://127.0.0.1:3100` just as it does for native mode.
- **Host port override:** `PORT=3200 docker compose up -d --build` publishes `127.0.0.1:3200`; the container still uses port 3100.
- **Browser allowlist:** `ALLOWED_ORIGINS` is passed to the container. An empty value permits every browser origin; configure an exact allowlist for your deployment.
- **Simulation:** Compose fixes TEST_GIFTS=0 and the image defaults to NODE_ENV=production. The app refuses production startup if simulation is enabled; use a private non-production development/test instance for simulation.
- **Resource isolation:** Compose uses a read-only root filesystem, 16 MiB temporary filesystem, dropped capabilities, no-new-privileges, 512 MiB memory, 1 CPU and 64 PIDs. These are deployment budgets, not a tested event-throughput guarantee.
- **Storage:** no volume or database is required. Do not bind-mount macOS node_modules into Linux; the image installs dependencies for its own platform.
- **Logs:** Compose rotates json-file logs at 10 MB per file with up to three files. Logs can contain usernames and gift details; this is not an audit log or event store.
- **Healthcheck:** the image checks GET / every 30 seconds with a 3-second request deadline. This checks HTTP process reachability only, not TikTok connectivity or event completeness.
- **Restart:** `unless-stopped` restarts a failed/exited container and normally starts it when the Docker daemon starts, unless you explicitly stopped it. It does not keep a sleeping/offline computer available. Healthcheck failure alone does not restart the container.

Shell variables override Compose's `.env` interpolation values. Keep overrides consistent across up/build/config commands; an inline variable on one command is not persistent configuration.

The default Compose network allows outbound HTTPS/WSS to TikTok. It provides no HTTPS termination, public tunnel, authentication or extra TikTok quota. A proxy in a **different container** cannot reach this service using that container's localhost: attach it to a shared Docker network and route to `backend:3100` instead. The bundled Compose file includes no proxy service.

### Update and stop

After updating the source or lockfile, rebuild and recreate:

```sh
docker compose up -d --build
```

To refresh the base image as well:

```sh
docker compose build --pull
docker compose up -d
```

The major-version base-image tag follows Node 24 updates; it is not pinned to an immutable digest. Pin a verified digest in your deployment if byte-for-byte image reproducibility is required.

Stop and remove this Compose deployment:

```sh
docker compose down
```

Stopping/recreating disconnects SSE clients and clears in-memory rooms. There is no data volume to migrate and no missed-event replay. The service is not a zero-downtime cluster.

### Move to a Linux machine

Transfer the project source, Dockerfile, compose.yaml and lockfile; do not transfer node_modules or runtime history. For example, create a source archive on your current machine:

```sh
tar -czf tiktok-live-backend.tar.gz Dockerfile compose.yaml .dockerignore package.json package-lock.json server.js src README.md docs AGENTS.md test
scp tiktok-live-backend.tar.gz your_user@your_linux_host:~/
```

On the Linux host, with Docker/Compose already installed:

```sh
mkdir -p ~/tiktok-live-backend
tar -xzf ~/tiktok-live-backend.tar.gz -C ~/tiktok-live-backend
cd ~/tiktok-live-backend
```

Create the host's `.env` file as above, then start:

```sh
docker compose up -d --build
curl http://127.0.0.1:3100/
```

Recreate your local deployment settings and HTTPS proxy/tunnel on the Linux host. Build there so Docker selects the base image for its CPU architecture; an ARM-only image built on an Apple Silicon Mac is not automatically portable to an x86 Linux host. Do not force a platform unless you intentionally configure cross-building/emulation.

## HTTPS and public access

For this domain's named-tunnel deployment, follow [Cloudflare setup](cloudflare.md) and apply compose.cloudflare.yaml together with the base Compose file. It supplies a controlled loopback peer and explicitly selects CF-Connecting-IP.


A deployed HTTPS website should connect to an HTTPS API URL. A public URL may be provided by a tunnel or reverse proxy forwarding to `http://127.0.0.1:3100` on the backend machine. This host-loopback URL works with native defaults and the bundled Compose port mapping; adjust the port if overridden.

Requirements:

- The backend must remain running as a long-lived process. A typical short-lived serverless function is not a substitute for this persistent TikTok/SSE service.
- The proxy must support long-running streaming HTTP responses without buffering until completion.
- The proxy must forward browser Origin headers and preserve the SSE content type/body.
- Use TLS for public traffic, monitor proxy timeouts, and test the real browser-to-proxy-to-backend path.
- Bind a tunnel to the backend's loopback port; do not assume loopback is reachable from another device or container.

The backend sends `Access-Control-Allow-Private-Network: true`, but this does not override mixed-content rules, browser local-network permission requirements, enterprise policies or other access restrictions. Do not rely on it to make an HTTPS site's localhost connection work in every browser.

### Example: Nginx reverse proxy

This is a configuration example, not a deployment script. Replace `events.example` and provision the matching TLS certificate before using it. Terminate TLS at the proxy; the Node process remains on loopback.

```nginx
server {
    listen 443 ssl;
    server_name events.example;

    ssl_certificate /etc/letsencrypt/live/events.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/events.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

The backend sends a heartbeat comment every 15 seconds to keep a healthy quiet SSE stream active. Proxy/provider timeouts and buffering can still break streaming; test the full path. The 300-second timeout is an example, not a guarantee about upstream TikTok activity.

Before public deployment, configure exact TRUSTED_PROXIES and have the immediate proxy overwrite X-Forwarded-For with one verified client IP. For a direct client-to-Nginx deployment add `proxy_set_header X-Forwarded-For $remote_addr;` to the location block. If a CDN/proxy precedes Nginx, configure trusted real-IP handling there first; see [trusted proxy setup](security.md#trusted-proxy-setup-required-for-correct-client-ip-limits). The container may see a Docker gateway address rather than 127.0.0.1.

Do not add a second, conflicting set of CORS headers at the proxy. Keep a single CORS policy owner, or explicitly design and test any proxy override.

## Security and operational boundaries

- **CORS is not authentication.** Requests without Origin are accepted; non-browser callers can spoof Origin. Use an authenticated gateway or private access boundary if the service is not intended to be public.
- **Keep `TEST_GIFTS` disabled publicly.** Simulation injects events into subscribed rooms and permits broadcasting to all existing rooms by omitting username. Its cross-site header check is not a security token.
- Public access is intentional. The backend now enforces bounded in-memory request/stream quotas, trusted proxy identity, frame/queue limits and HTTP input budgets; it still does not authenticate users or provide durable queues.
- See the [exact default limit table and publish checklist](security.md). Quotas reset on restart and are independent across replicas. Do not infer production load capacity or bot resistance from offline tests.
- Routine gift-sender logs are removed. Connection logs can contain monitored usernames and escaped upstream errors. Client payloads still contain user identifiers, comments and image URLs; apply appropriate access/retention policies if adding storage.
- Do not expose private cookies or tokens in query strings. The current app does not configure login cookies, proxies or third-party signing services.
- Client-provided image URLs are not fetched by the backend. Clients should render text safely and handle missing/expired images rather than treating remote content as trusted HTML.

## Capacity, restarts and scaling

Each process can maintain **10 room entries** at once. A room is keyed by normalized username and shares one upstream connection among its clients. An empty room remains in the map for 10 seconds before cleanup, so it can still temporarily consume a slot.

The TikTok library has its own connection supervision/retries. If it ultimately reports failure or disconnection, the backend schedules its own retry: the first two backend retries wait 3 seconds each, later retries wait 30 seconds. The backend failure count resets after a successful connection. These delays are not a complete upper bound on recovery time because upstream operations and library retries also take time.

All state is in memory. A restart disconnects clients, clears rooms and loses any undelivered events. EventSource can reconnect, but there is no replay or `Last-Event-ID` support.

Multiple backend processes do not share rooms or deduplicate upstream connections. If a load balancer routes clients for the same username to different processes, each process can open its own TikTok connection. Shared routing/state is not implemented here.

## Troubleshooting

| Symptom | Checks and likely cause |
|---|---|
| Connection refused | Check the native process or `docker compose ps`, the configured port and the URL. Native mode defaults to loopback; Compose defaults to loopback-only host publishing. Check HOST inside the container if overriding image settings. |
| Root responds, but TikTok events never arrive | `/` checks process reachability only. Subscribe to `status`, verify the exact username is LIVE, and inspect backend logs for TikTok/library failures. |
| HTTP 400 on `/events` | Provide a username matching the documented syntax; encode query parameters and remove accidental spaces/URL fragments. |
| HTTP 403 in a browser | Check the exact Origin against `ALLOWED_ORIGINS`. Simulation also rejects `Sec-Fetch-Site: cross-site`. |
| HTTP 503 | All 10 room slots are occupied. Close unused subscriptions and allow the 10-second grace period to expire. |
| Simulation returns 404 | Restart with `TEST_GIFTS=1`; the flag is disabled by default and its name remains unchanged. |
| Simulation returns `ok (rooms: 0)` | No target room exists. Open `/events?username=...` first and use the same case. Nothing is queued for future subscribers. |
| SSE looks connected but no application callbacks fire | Use named listeners such as `addEventListener('gift', ...)`; `onmessage` alone is insufficient. Separate backend transport status from TikTok status. |
| Events arrive in bursts through a proxy | Disable response buffering/caching and verify the proxy supports streaming. |
| Quiet connections disconnect periodically | Check proxy/provider idle timeouts and buffering; heartbeat comments should pass every 15 seconds. Slow clients exceeding the 256 KiB pending-byte limit are deliberately disconnected. |
| HTTP 429 | Read Retry-After, reduce request/reconnect concurrency and check client-IP forwarding. Visitors may share a proxy/NAT IP if configured incorrectly or legitimately behind shared access. |
| Avatar or gift image is blank | The field may be empty, the URL may have expired or failed, or an HTTPS page may block an HTTP image. Show a fallback. |
| Gift score is too high | `diamonds` already includes the completed combo quantity. Do not multiply by repeatCount again; consider duplicate event handling. |
| Missing likes, joins or followers | TikTok may batch or omit messages. This is not a complete audit feed; inspect actual payloads before assuming all activity is represented. |
| HTTPS website cannot reach localhost | Check mixed content, local-network permissions, Origin, firewall and the fact that localhost belongs to the visitor's computer. Prefer a reachable HTTPS backend URL. |

### Inspect the raw stream

```sh
curl -i -N 'http://127.0.0.1:3100/events?username=your_username'
```

`-N` disables curl's output buffering. Use Ctrl+C to close the stream. Test both the local URL and your public HTTPS URL; success locally does not verify proxy/browser behavior.

### Run offline verification

```sh
npm test
```

The tests cover local normalization, synthetic messages through the installed library decoder, fake-connector HTTP/SSE behavior and documentation examples. They make no TikTok requests. Browser/React runtime behavior, actual image availability, Nginx/TLS configuration and a real TikTok LIVE session require separate environment-specific validation.

## Dependency and service availability

The installed `piratetok-live-js@0.3.0` library executes inside the backend process. Its current live connection path resolves rooms and cookies from TikTok and opens a WebSocket to TikTok; it does not call a PirateTok API/signing server. An outage of the library's website does not by itself stop an already installed backend.

The project still depends on the installed library and its dependencies, the host/network, and TikTok's unofficial protocol. A package registry outage can affect installation; abandoned or incompatible code can require maintenance; TikTok can change its protocol or block requests. Running your own backend does not remove those limitations.
