# Public Access, Limits and Publish Checklist

[README](../README.md) · [Client API](client-api.md) · [Deployment](deployment.md)

## Access model: public, not authenticated

This deployment is intentionally available to **any caller**, with no login and no per-user TikTok allowlist. Anyone can select a syntactically valid LIVE username, subject to resource limits. There is no database, account registry, API key or session/token store.

A permanent API secret embedded in a public frontend would not protect this service. Publicly issuing access tickets would not prove a caller is trusted either. The controls below bound resource use; they are **not user authentication**, proof of TikTok account ownership, or protection against every distributed bot attack.

If private access is needed later, add an authenticated gateway or a separately designed identity/authorization flow. Do not disguise CORS or an exposed frontend key as authentication.

## Hard limits and defaults

All limits are **per backend process**. Defaults are conservative resource policies, not benchmarked throughput or TikTok quotas.

| Resource | Default | Configuration / behavior |
|---|---|---|
| Concurrent monitored LIVE usernames | 10 | Fixed room cap; a new room beyond it returns 503 |
| Concurrent SSE client connections | 100 | `MAX_CLIENTS`; excess streams return 503 |
| Concurrent SSE connections per client IP | 5 | `MAX_CLIENTS_PER_IP`; excess streams return 429 |
| HTTP requests per IP per minute | 60 | `REQUESTS_PER_MINUTE`; excess requests return 429 |
| HTTP requests per process per minute | 600 | `GLOBAL_REQUESTS_PER_MINUTE`; excess admitted requests return 429 |
| Tracked IP records in RAM | 4096 | Fixed bound; new identities are rejected with 429 if full |
| Outbound SSE frame | 64 KiB UTF-8 | Oversized data/status events are omitted, not split or replayed |
| Pending Node response bytes per SSE client | 256 KiB | A write that would exceed it disconnects that slow client |
| SSE heartbeat | Every 15 seconds | Comment frame `: heartbeat`; no application event payload |
| Request URL | 4096 bytes | Excess returns 414 |
| HTTP headers | 8192 bytes, at most 32 header entries | Excess returns 431 |
| Request headers / full incoming request | 10 / 15 seconds | Node HTTP timeouts; these do not impose a 15-second limit on an already-open SSE response |
| TCP connections | MAX_CLIENTS + 100 | Additional transport-level ceiling; excess connections can be closed without an HTTP response |
| Docker memory / CPU / processes | 512 MiB / 1 CPU / 64 PIDs | Compose budgets; adjust only after measurement |

Per-minute request counters use **fixed 60-second windows**, not a smooth per-second limiter. They permit bursts up to the configured count, including bursts near window boundaries. Requests rejected by an IP's request quota do not consume further global admission quota. These quotas apply to requests reaching application admission (including root health requests, OPTIONS, ordinary errors and reconnect attempts), **not each SSE event**. Malformed requests rejected by the HTTP parser or preliminary header/IP checks do not reach that gate.

The backend does not set an events-per-minute quota. Its sustainable event/client throughput is **not yet benchmarked**. TikTok may batch, omit, repeat or throttle upstream messages independently. No limit on the number of commenters or gift senders in a LIVE is configured; that does not guarantee complete tracking of every viewer.

A 429/stream-cap 503 response includes `Retry-After` in seconds. Clients should back off, and should not open extra parallel streams to work around rejection. Native EventSource may expose only an opaque error rather than that header; use DevTools/terminal diagnostics and avoid tight manual reconnect loops.

Closing a response releases its client slot. When a room loses its last client, its **10-second grace period** still consumes a room slot. Existing admitted streams are not terminated merely because a new HTTP request hits a request quota. There is no paid-user priority or per-account fairness.

## State and scaling without a database

All counters and connection leases live in RAM. Inactive IP records are expired lazily; active stream counts survive request-window resets. Restarting the process resets quotas and disconnects streams. No counters, comments, images, event history or authentication state are written to a DB.

Multiple replicas have independent room/connection/rate limits. Increasing replica count multiplies potential upstream connections and quota allowances; it does not create a shared global budget. Use gateway limits/shared coordination when scaling. Redis or a database is **not required for the current single-process deployment**, but shared enforcement would need an appropriate shared owner later.

Public IP limits have tradeoffs: people behind the same NAT share an allowance, while a distributed botnet can spread traffic across IPs. A small number of callers can still occupy all publicly available stream/room slots. For stronger abuse resistance, configure edge-level connection/request limits, provider DDoS protection and, if needed, a user challenge or authentication. This backend cannot stop upstream bandwidth saturation.

## Trusted proxy setup: required for correct client-IP limits

By default, **all forwarding headers are ignored** and the TCP peer IP is used. Configure `TRUSTED_PROXIES` only with exact IP addresses of your immediate, controlled reverse proxies. Hostnames and CIDRs are rejected. IPv4-mapped socket addresses are normalized.

For a request from a trusted immediate peer, the app accepts **exactly one valid IP** in the selected header. CLIENT_IP_HEADER defaults to x-forwarded-for; the optional cf-connecting-ip mode is only for a controlled Cloudflare origin path as described in [Cloudflare setup](cloudflare.md). A malformed value, multiple values or a comma-separated proxy chain returns 400. If the trusted peer sends no header, it is conservatively counted as the peer itself. Forwarded and X-Real-IP are never identity sources. Only the selected CLIENT_IP_HEADER is read; other headers cannot act as a fallback. Untrusted peers cannot select their own identity even by sending the configured header.

Your immediate proxy must **overwrite**, not blindly preserve/append an untrusted inbound value:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
```

Set TRUSTED_PROXIES to the immediate proxy IP **as seen by the backend**. Native loopback and Docker gateway addresses are not necessarily the same. Do not assume the container sees 127.0.0.1 merely because Nginx connects to the host's loopback-published port.

Do not trust all private networks or every Internet client. If a second proxy/CDN is involved, first configure trusted real-client-IP handling at the immediate proxy using that provider's current documented IP ranges, then send a single sanitized address to this backend. Alternatively, use the bundled Cloudflare overlay, which trusts only connector loopback and selects Cloudflare's single-address header rather than a caller-influenced X-Forwarded-For chain. Do not trust a caller-supplied CDN header by name alone.

Without correct forwarding configuration, every visitor behind a proxy may share one IP quota. Keep the published port private so callers cannot bypass the controlled proxy. This is a deployment prerequisite, not something the app can infer safely from arbitrary headers.

## Other safeguards

- The app accepts GET/OPTIONS on stream/simulation routes and GET/HEAD/OPTIONS on the root. Unsupported request methods return 405; request bodies are rejected. OPTIONS does not open a TikTok room.
- Invalid numeric limits and malformed origin/proxy configuration fail startup rather than silently disabling protection. Empty ALLOWED_ORIGINS still means wildcard browser CORS; set it deliberately.
- CORS includes Vary: Origin and never substitutes for identity or rate limiting.
- Responses include no-sniff, no-referrer and a restrictive content-security policy. Public HTTPS/HSTS belongs to the TLS proxy; the backend does not infer HTTPS from arbitrary forwarding headers.
- SSE responses disable proxy transformation/buffering and send heartbeat comments. Slow/closed clients do not block broadcast to healthy clients. The byte limit bounds Node's response queue, not every kernel, proxy or library allocation.
- Production (`NODE_ENV=production`) refuses startup if `TEST_GIFTS=1`. Compose also fixes simulation off. Local simulation requires a non-production development/test environment and private network access.
- Routine gift-sender logging is removed. Connection logs can still contain monitored usernames and upstream error descriptions; control-character escaping prevents multiline log injection in first-party connection/error logs. Keep log access and retention appropriate for user data.
- Docker runs as non-root with a read-only root filesystem, a 16 MiB temporary filesystem, dropped capabilities, no-new-privileges, resource budgets and bounded log rotation. These are defense in depth, not proof of a complete security audit.

## Before publishing

- [ ] Set exact ALLOWED_ORIGINS for your frontend(s); do not put a secret in browser source.
- [ ] Keep TEST_GIFTS disabled and NODE_ENV=production.
- [ ] Keep Docker/native host publishing on loopback behind a controlled HTTPS gateway.
- [ ] Configure a real domain and TLS. Add HSTS only after verifying correct HTTPS behavior.
- [ ] Configure TRUSTED_PROXIES and a single overwritten X-Forwarded-For using the actual proxy topology. Verify that spoofed input cannot change identity.
- [ ] Set edge-level abuse controls and provider bandwidth/DDoS protection. Application limits alone cannot protect every layer.
- [ ] Review MAX_CLIENTS, MAX_CLIENTS_PER_IP, REQUESTS_PER_MINUTE and GLOBAL_REQUESTS_PER_MINUTE for your audience. Test shared-NAT users and reconnect behavior.
- [ ] Verify normal flows, 429/503 responses, closed/slow clients, SSE heartbeat and proxy idle timeouts.
- [ ] Measure realistic CPU/memory/event throughput before advertising capacity. Do not advertise guaranteed TikTok events/minute or complete viewer tracking.
- [ ] Review logging, restart behavior and maintenance/rollback steps. Monitor health, resource use and repeated rejection errors without storing sensitive payloads unnecessarily.
- [ ] Validate against a separately authorized real LIVE session. Offline tests prove local behavior only.

No public tunnel, domain, account, external identity provider or DB is provisioned by this preparation. Publish only after completing the environment-specific checklist.
