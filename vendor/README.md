# Patched TikTok dependency

The backend pins [piratetok-live-js-0.3.0-cam.1.tgz](piratetok-live-js-0.3.0-cam.1.tgz) through package.json and package-lock.json. This is a narrowly patched copy of the published `piratetok-live-js@0.3.0`, not a new event protocol or a replacement connector. npm installs it normally, including with `--ignore-scripts`; no install hook, runtime loader or additional dependency is required.

## Provenance and scope

- Upstream repository: https://github.com/PirateTok/live-js
- Upstream package: https://registry.npmjs.org/piratetok-live-js/-/piratetok-live-js-0.3.0.tgz
- Upstream SHA-256: `adeb686db6f3b71e3cb986d28e16ede3f018581e9b748a6fbf9cd01ac93cc79a`
- Upstream npm integrity: `sha512-MqMhXUFIO1QnBdeLkH25JLo7YHwtegvZD+C/fe9Y9bq1ocnZ5PYD2mL00o84Hx2vbpgOaG7NHG2Fnkie87JIYA==`
- Patched archive SHA-256: `47c25f91444a0488fcdfe2a763030defe00d7c5e89c5f415e29798897f61b52c`
- License: upstream **0BSD**, retained as LICENSE inside the archive.
- Complete source changes: [piratetok-live-js-0.3.0-cam.1.patch](piratetok-live-js-0.3.0-cam.1.patch).

The patch:

1. Keeps the HTTP timeout signal attached until response-body consumption finishes, using native AbortSignal.timeout rather than clearing a timer when only headers arrive.
2. Creates the connection's abort controller before room discovery and uses it through lookup, cookie discovery, retry waits and WSS supervision. Cancellation cannot start a late session; a successful initial handshake does not discard the active controller.
3. Updates the affected TypeScript declarations and package version. Removes stale source-map references from modified JavaScript; untouched upstream files and dependencies are preserved.

The timeout remains per HTTP operation, not a new wall-clock budget for the entire retrying connection. Existing backend retry delays, event payloads and HTTP/SSE endpoints are unchanged. Tests use mocked HTTP/transport seams; they do not prove real TikTok availability.

## Reproduce and inspect

Run from the repository root with npm, Git, tar and shasum available. These commands download only the public upstream package, apply the committed diff in a temporary directory and compare the resulting archive. They do not modify node_modules or contact TikTok.

```sh
ROOT=$(pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
npm pack piratetok-live-js@0.3.0 --ignore-scripts --pack-destination "$work"
printf '%s  %s\n' \
  'adeb686db6f3b71e3cb986d28e16ede3f018581e9b748a6fbf9cd01ac93cc79a' \
  "$work/piratetok-live-js-0.3.0.tgz" | shasum -a 256 -c -
tar -xzf "$work/piratetok-live-js-0.3.0.tgz" -C "$work"
(cd "$work/package" && git apply --check "$ROOT/vendor/piratetok-live-js-0.3.0-cam.1.patch")
(cd "$work/package" && git apply "$ROOT/vendor/piratetok-live-js-0.3.0-cam.1.patch")
npm pack "$work/package" --ignore-scripts --pack-destination "$work"
cmp "$work/piratetok-live-js-0.3.0-cam.1.tgz" "$ROOT/vendor/piratetok-live-js-0.3.0-cam.1.tgz"
```

For an upstream upgrade, review these changes against the new release, run the lifecycle/decoder/full test suites, and remove the local patch only once equivalent timeout/cancellation behavior is qualified. Do not silently substitute an unreviewed registry version. Rolling back requires restoring the matching package.json, lockfile and archive together, then running npm ci; restoring node_modules by hand is not a rollback.
