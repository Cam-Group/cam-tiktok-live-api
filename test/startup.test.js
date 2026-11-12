import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backendEnv } from '../test-support/backend-env.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('standalone production startup rejects an invalid deployed origin', () => {
  const child = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env: backendEnv({ NODE_ENV: 'production', TEST_GIFTS: '0', ALLOWED_ORIGINS: 'https://game.example/' }),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ALLOWED_ORIGINS must contain exact HTTP\(S\) origins without paths/);
  assert.doesNotMatch(child.stdout, /Backend listening/);
});

for (const host of [undefined, '0.0.0.0']) {
  test(`standalone startup uses ${host ?? 'the loopback default'} without contacting TikTok`, { timeout: 10000 }, async t => {
    const port = await unusedPort();
    // Hosting configuration must not change what this startup fixture exercises.
    const env = backendEnv({ PORT: String(port), NODE_ENV: 'production', TEST_GIFTS: '0', ALLOWED_ORIGINS: 'https://game.example' });
    if (host === undefined) delete env.HOST; else env.HOST = host;
    const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    });
    let stdout = '', stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup deadline exceeded: ${stderr}`)), 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes(`Backend listening on ${host ?? '127.0.0.1'}:${port}.`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited with ${code}: ${stderr}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /^TikTok LIVE backend is running\./);
    const simulation = await fetch(`${base}/gift`, { signal: AbortSignal.timeout(2000) });
    assert.equal(simulation.status, 404);
    await simulation.text();
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok\n');
    // Exercise the real entry point's signal handler, not the test runner's cleanup.
    child.kill(host ? 'SIGTERM' : 'SIGINT');
    assert.equal(await exited, 0);
    assert.equal(child.signalCode, null);
    assert.match(stdout, /Backend shutting down\./);
    assert.equal(stderr, '');
  });
}
