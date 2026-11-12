# Publish with a Named Cloudflare Tunnel

[README](../README.md) · [Security checklist](security.md) · [Deployment](deployment.md)

Deployment hostname: **tiktok-live-api.vinhvu-cam.id.vn**. The domain must be active in your Cloudflare account. Do not replace an existing DNS record for this hostname without checking what it serves.

This setup uses a remotely managed, named Cloudflare Tunnel, not a temporary Quick Tunnel. Cloudflare documents that Quick Tunnels do **not** support SSE. No router port forwarding, public origin IP, database or frontend secret is needed.

## Topology

```text
Browser -> https://tiktok-live-api.vinhvu-cam.id.vn -> Cloudflare edge
  -> outbound cloudflared tunnel -> backend on 127.0.0.1:3100 inside its network namespace
```

Apply compose.cloudflare.yaml together with compose.yaml. The cloudflared container shares the backend's network namespace, not its filesystem. This gives a known immediate peer of 127.0.0.1, without trusting an entire Docker subnet. The host-published backend port remains loopback-only.

The overlay selects `CLIENT_IP_HEADER=cf-connecting-ip` and `TRUSTED_PROXIES=127.0.0.1`. Cloudflare supplies the visitor address in CF-Connecting-IP. Do not use unvalidated X-Forwarded-For chains, which can include caller input. This mode is only safe behind the controlled tunnel/edge path; local processes with access to the trusted network namespace are part of the deployment trust boundary.

The tunnel token is a credential for this tunnel, not an account-wide API key. It is mounted only into cloudflared via a local file/Compose secret; it is not passed in the command line, backend environment or image build context. Local Compose secrets are file mounts, not an encrypted secret vault. Host administrators and Docker administrators can still access them.

## 1. Create the tunnel in your account

You must perform account authorization yourself. Do not send passwords, tokens, screenshots containing tokens, or full install commands to a chat.

1. Open [Cloudflare Tunnels](https://dash.cloudflare.com/?to=/:account/tunnels). Current documentation places it under **Networking > Tunnels**; some accounts may show **Zero Trust > Networks > Connectors/Tunnels**.
2. Create a Cloudflare/cloudflared tunnel named `tiktok-live`.
3. On the connector installation screen choose Docker and copy **only the token** shown after `--token` in the install command. Do not run the dashboard's separate docker run command: this project owns the connector through Compose.
4. Store the token locally using the hidden prompt below. Do not create a broad Cloudflare API token or use an account-wide origin certificate for this setup.

## 2. Store the token locally

From the project directory, run this command in your own terminal. Python prompts without echo and refuses to overwrite an existing token file:

```sh
python3 - <<'PY'
import getpass
import os
from pathlib import Path

folder = Path('.secrets')
if folder.is_symlink():
    raise SystemExit('Refusing a symlinked secrets directory')
folder.mkdir(mode=0o700, exist_ok=True)
folder.chmod(0o700)
path = folder / 'cloudflare-tunnel-token'
if path.exists() or path.is_symlink():
    raise SystemExit('Token file already exists; rotate deliberately rather than overwrite')
token = getpass.getpass('Paste the tunnel token (hidden): ').strip()
if not token or any(c.isspace() for c in token):
    raise SystemExit('Expected the token only, not the full install command')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write(token + '\n')
    output.flush()
    os.fchmod(output.fileno(), 0o644)
print('Saved tunnel credential; its value was not printed.')
PY
```

The enclosing directory is mode 0700 (owner-only). The file is mode 0644 so the non-root connector can read its isolated read-only mount; other host users cannot traverse the private enclosing directory. Do not loosen the directory permissions or copy the token into .env. The .secrets directory is ignored by version control and excluded by the Docker build allowlist.

## 3. Configure local deployment settings

If .env does not exist, copy .env.example to .env and edit it. Do not overwrite existing deployment settings blindly.

For initial local frontend development use exact origins such as `http://localhost:5173` or `http://localhost:3000`. When Vercel assigns a production URL, add its exact origin, for example `https://your-game.vercel.app`. Do not allow every `*.vercel.app` site and do not invent a URL before deployment. There is no frontend access token to distribute.

The Cloudflare overlay owns proxy/header settings. Keep TEST_GIFTS off. Leave HOST and the internal backend port unchanged. PORT in .env controls only the host-published port.

## 4. Start the hardened backend and connector

Use the existing project name on this machine to replace the existing backend instead of starting another instance on port 3100:

```sh
docker compose -p tiktoklive-docker-qa -f compose.yaml -f compose.cloudflare.yaml up -d --build --wait --wait-timeout 90
docker compose -p tiktoklive-docker-qa -f compose.yaml -f compose.cloudflare.yaml ps
docker compose -p tiktoklive-docker-qa -f compose.yaml -f compose.cloudflare.yaml logs --tail 30 cloudflared
```

This recreates the backend, disconnecting existing SSE clients briefly. The connector will make outbound connections to Cloudflare; a restrictive network must allow its documented tunnel egress (port 7844). The pinned connector image is updated deliberately, not automatically.

Wait until Cloudflare reports the connector healthy. Backend health checks only local HTTP, not tunnel readiness, TikTok availability or end-to-end SSE. Starting a connector does not by itself prove the DNS route is published.

## 5. Add the public hostname route

In the tunnel dashboard, choose **Routes > Add route > Published application** (older UI: **Public Hostnames > Add a public hostname**):

- Subdomain: `tiktok-live-api`
- Domain: `vinhvu-cam.id.vn`
- Path: leave empty (match all paths)
- Service type: `HTTP`
- Service URL: **`http://127.0.0.1:3100`** (if the UI separates type from URL, enter `127.0.0.1:3100`)

The loopback address is correct because the connector and backend share a network namespace. Do not use the host's public IP, host.docker.internal, HTTPS for this HTTP-only origin, or a frontend URL.

Saving normally creates the proxied CNAME to the tunnel automatically. If you must add it manually, use `tiktok-live-api` -> `<tunnel-uuid>.cfargotunnel.com` as a proxied CNAME, using this tunnel's actual UUID. Do not add an A record to the Mac's private IP. Resolve any existing record conflict deliberately.

For this hostname:

- Keep streaming/chunked transfer enabled; do not introduce a buffering Worker, cache-everything rule or response transform that buffers SSE. Add a cache-bypass rule for the hostname if your zone otherwise overrides origin no-store/no-cache behavior.
- Do not enable an interactive Cloudflare Access login challenge on this public browser EventSource route. The selected access policy is public with resource limits, not user authentication.
- Do not remove visitor IP headers with a Managed Transform or rewrite CF-Connecting-IP. Keep Pseudo IPv4 disabled or in Add Header mode rather than Overwrite Headers.
- Same-zone Workers can alter visitor-IP semantics; do not route this hostname through such a Worker without reviewing the trust boundary. Cross-zone Worker requests may share Cloudflare's fixed Worker IP and therefore share its quota.
- Apply suitable edge WAF/rate controls when available, without an HTML challenge on every legitimate EventSource request. Account plans differ; this project does not provision paid features.

## 6. Verify and connect the frontend

After DNS/TLS and the route are active:

```sh
curl -i --max-time 10 https://tiktok-live-api.vinhvu-cam.id.vn/
curl -i --max-time 10 'https://tiktok-live-api.vinhvu-cam.id.vn/events?username=invalid!'
```

Expect root HTTP 200 and invalid username HTTP 400, rather than a Cloudflare error or login HTML. These checks do not contact TikTok. Validate CORS using your actual frontend Origin, then separately authorize a bounded real LIVE subscription to test upstream events and sustained SSE through the edge.

Frontend base URL:

```js
const url = new URL('/events', 'https://tiktok-live-api.vinhvu-cam.id.vn');
url.searchParams.set('username', 'your_username');
const source = new EventSource(url);
source.addEventListener('chat', message => console.log(JSON.parse(message.data)));
source.addEventListener('status', message => console.log(JSON.parse(message.data).text));
// source.close() on teardown.
```

Public publishing does not make the Mac always-on: Docker Desktop, the host and network must stay up. Reuse the same Compose files and a deliberately migrated/rotated tunnel credential on a Linux host later; no DB migration is required.

## Stop, rollback and rotate

To stop public traffic without stopping the local backend:

```sh
docker compose -p tiktoklive-docker-qa -f compose.yaml -f compose.cloudflare.yaml stop cloudflared
```

To stop the entire deployment, use the same files/project with `down`. After changing the backend container, always use both Compose files so the shared-network connector is recreated consistently. Do not switch between base-only and overlay up commands on a live tunnel without checking connector attachment.

To revoke a leaked credential, rotate the tunnel token in Cloudflare, stop the connector, replace the local credential deliberately, and recreate the connector. Never print the old/new token or pass it in shell arguments. Restore previous images/configuration if rollout fails; all rooms/quotas reset during a backend restart and missed events are not replayed.

## Primary references

- [Create and publish a named tunnel](https://developers.cloudflare.com/tunnel/get-started/)
- [Tunnel token-file parameter](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file)
- [Cloudflare visitor IP header semantics](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-connecting-ip)
- [Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
