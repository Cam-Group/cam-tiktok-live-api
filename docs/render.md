# Deploy on Render Free

[README](../README.md) · [Deployment](deployment.md) · [Client integration](client-guide.md) · [Security](security.md)

This is a **trial deployment**, not an always-on LIVE service. The repository's [render.yaml](../render.yaml) creates one native Node.js web service on the Free plan. No database, disk, Docker daemon, Cloudflare Tunnel or secret token is required. Creating the service is a separate action in your Render account; this preparation does not provision anything.

## 1. Push and create the service

1. Push this project, including render.yaml, package-lock.json and the vendor directory, to a Git repository that Render can access. Never commit .env, .secrets, tunnel tokens or node_modules. Review any other local changes before including them.
2. In the [Render Dashboard](https://dashboard.render.com/), choose **New > Blueprint** and connect the repository/branch. Use render.yaml at the repository root.
3. When prompted for **ALLOWED_ORIGINS**, enter the exact frontend origin, such as `https://your-app.vercel.app`. Multiple origins are comma-separated. Include the scheme; omit paths and trailing slashes. Do not use `*` or leave it empty. Preview deployments need their own exact allowed origin.
4. Confirm that the service is a **Web Service**, runtime **Node**, plan **Free**, and only one instance. Review the current Free limits and any account spending controls before creating it.
5. Deploy. The build runs `npm ci --ignore-scripts && NODE_ENV=test npm test`; a failing test blocks deployment. The test-only environment permits offline simulation fixtures without enabling simulation in the deployed process. The start command is `npm start` with NODE_ENV=production.
6. Wait for a successful deploy and copy the service's assigned `https://<service>.onrender.com` URL. The name/subdomain may differ from the example.

For manual creation through **New > Web Service**, use the same commands and copy the environment variables from render.yaml. Set the health check path to `/healthz`. The Blueprint is preferred because it keeps these settings together.

## 2. Configuration and safety

| Setting | Prepared value / action |
|---|---|
| Node | Major version 24, matching the Docker image's supported release line |
| Bind address | `HOST=0.0.0.0`, required for Render's router |
| Port | **Do not set PORT**; Render supplies it and the server already reads it |
| Production | `NODE_ENV=production`, `TEST_GIFTS=0` |
| Browser access | Enter ALLOWED_ORIGINS when creating the Blueprint |
| Health check | `GET /healthz`: process liveness only; no TikTok request |
| Quotas | 100 streams/process, 5/socket-peer IP, 60 requests/minute/socket-peer IP, 600/process |
| Forwarded identity | TRUSTED_PROXIES is empty; CLIENT_IP_HEADER is not trusted without a configured peer |
| State | RAM only; restarting or sleeping loses connections, quotas and room state |

### Proxy IP limitation: required before a wider public launch

Render places proxies in front of the app. With this Blueprint, forwarded headers are deliberately **ignored**: visitors can share the proxy's quota of **5 streams and 60 requests/minute**. The limit is per observed socket peer, not reliably per visitor. This is safe and suitable for a small trial, but it can reject legitimate concurrent users. It is not qualified for a larger public audience.

Do not set TRUSTED_PROXIES to `*`, private-network ranges or guessed addresses, and do not blindly use the first X-Forwarded-For value. Render proxy chains can contain multiple addresses; the existing exact-proxy mode intentionally rejects chains rather than trusting caller input. Leaving trust empty avoids that rejection but does not provide real per-visitor quotas.

Before widening access, qualify Render's actual header rewriting and immediate peer topology with controlled requests from two independent networks, including caller-supplied X-Forwarded-For and CF-Connecting-IP values. Then configure a supported, verified single-address gateway path as described in [trusted proxy setup](security.md#trusted-proxy-setup-required-for-correct-client-ip-limits), or implement and test a Render-specific resolver against that verified contract. This preparation does not claim that qualification has occurred. Raising MAX_CLIENTS_PER_IP is **not** a fix for client identity and weakens the shared-bucket cap.

CORS is not authentication: the API remains public, and non-browser callers can use it within its limits. Review [public access and abuse controls](security.md).

## 3. Verify the deployed service

Replace the URL and origin below. These first checks do not contact TikTok:

```sh
BASE='https://your-service.onrender.com'
ORIGIN='https://your-app.vercel.app'

curl --fail-with-body --max-time 90 "$BASE/healthz"
curl --fail-with-body --max-time 90 -i -H "Origin: $ORIGIN" "$BASE/"
curl --max-time 90 -i -H 'Origin: https://not-allowed.example' "$BASE/"
curl --max-time 90 -i "$BASE/gift"
```

Expected results:

- `/healthz`: HTTP 200 and `ok`. A cold start can delay the first request. This endpoint is not a TikTok or tunnel readiness check.
- `/` with your allowed Origin: HTTP 200 and Access-Control-Allow-Origin matching it.
- `/` with a disallowed Origin: HTTP 403, not wildcard browser access.
- `/gift`: HTTP 404 because production simulation is off.

Only when you are ready to connect to a real LIVE, replace the username and run:

```sh
BASE='https://your-service.onrender.com'
ORIGIN='https://your-app.vercel.app'
curl -N --max-time 45 -H "Origin: $ORIGIN" \
  "$BASE/events?username=your_live_username"
```

This request **does contact TikTok**. Expect HTTP SSE data with `retry: 3000`, named `status` events and a `: heartbeat` comment every 15 seconds while the response stays open. Receiving a heartbeat proves streaming transport, not that TikTok connected. Check the status text and actual LIVE events separately. Curl exit 28 is expected when the 45-second observation deadline expires; an offline username or blocked upstream can still produce an HTTP 200 stream with failure statuses.

## 4. Connect the frontend

Use the Render HTTPS origin as the backend base URL and keep the `/events?username=...` route unchanged. Follow the [client integration guide](client-guide.md). For a Vercel or similar frontend, update the backend URL in its own environment/configuration and redeploy it. Never embed a server secret or tunnel token in frontend code.

Test in the real browser: open a stream, receive events, reload/close the page, and verify that the client reconnects without accumulating subscriptions. Keep native EventSource reconnection enabled. Health probes deliberately have no browser CORS header; use `/events` for frontend integration, not `/healthz`.

## Troubleshooting origin validation

If build or startup logs report `ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths`, correct **Environment > ALLOWED_ORIGINS** in Render and redeploy. Enter only the frontend origin, for example `https://your-app.vercel.app`, or a comma-separated list of exact origins. Do not include a trailing slash, URL path, wildcard, surrounding quotes or the `ALLOWED_ORIGINS=` prefix in the Dashboard value.

Offline test fixtures isolate all application settings (including origins, quotas, proxy identity and bind settings), so hosting configuration cannot mask the behavior under test. This does not repair or bypass invalid deployment settings: the actual production process still refuses to start with a malformed origin. A passing build alone does not prove that the runtime environment is valid. Do not remove CORS validation or drop the test build gate to work around this error.

## 5. Free-plan and LIVE limitations

- Render Free services spin down after **15 minutes without inbound traffic**, and waking them takes time. Do not rely on an open SSE response or outbound TikTok activity to prevent sleep. Do not add artificial keepalive traffic to evade Free limits. Use paid always-on compute for reliable availability.
- Free compute hours are shared by the workspace (currently 750 hours/month); other Free services can consume the allowance. Outbound bandwidth, build minutes, CPU/memory and provider policies still apply. A Free compute plan does not guarantee zero account charges: excess outbound bandwidth or build minutes can be billed when a payment method is present; without one, services/builds can be suspended instead. Review account spending controls and the current [Free service documentation](https://render.com/docs/free) before deployment.
- Render documents an HTTP response limit of **100 minutes**. SSE can reconnect earlier due to sleep, deploys, maintenance, network failures or proxy limits. There is no event history, Last-Event-ID replay or exactly-once delivery; events during a gap can be lost.
- TikTok can reject data-center egress or change its protocol. A healthy deploy does **not** guarantee that piratetok-live-js can connect from Render. Validate a real, separately authorized LIVE before relying on it. Do not remove safety controls to work around an upstream rejection.
- Keep a single instance. Additional replicas would duplicate rooms/upstream connections and multiply in-memory quotas, not share state.
- SIGTERM/SIGINT stops incoming requests, closes SSE sockets and invokes room cleanup, with a 10-second shutdown deadline. Clients must reconnect. This does not promise event delivery during restarts.

## 6. Updates, rollback and launch checklist

Deploy a reviewed Git commit. Render's build reruns offline tests; platform/API validation still happens in Render. For rollback, use Render's available deploy rollback action, or revert the Git commit and deploy again. A subsequent automatic deploy follows the selected branch, so keep that branch consistent with the intended rollback. Expect SSE reconnects and no replay.

- [ ] Render accepted the Blueprint and the plan is Free.
- [ ] ALLOWED_ORIGINS contains the actual frontend origin(s), not an empty value.
- [ ] Health, CORS and disabled-simulation checks passed against the assigned HTTPS URL.
- [ ] The frontend uses the Render URL and cleans up subscriptions.
- [ ] A real LIVE was validated from Render, separately from the offline suite.
- [ ] Shared proxy quotas are acceptable for this trial; real client-IP handling is qualified before widening access.
- [ ] Cold start, restart/reconnect and event-loss behavior are understood.
- [ ] Logs and Free usage are reviewed; no credentials or event payload archives were added.

### Platform references

- [Blueprint specification](https://render.com/docs/blueprint-spec)
- [Web services and port binding](https://render.com/docs/web-services)
- [Health checks](https://render.com/docs/health-checks)
- [Free service limits](https://render.com/docs/free)
- [Streaming responses on Render](https://render.com/articles/sse-vs-websockets-llm-streaming)
