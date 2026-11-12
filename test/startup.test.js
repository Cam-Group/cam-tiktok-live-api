import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

for (const host of [undefined, '0.0.0.0']) {
  test(`standalone startup uses ${host ?? 'the loopback default'} without contacting TikTok`, { timeout: 10000 }, async t => {
    const port = await unusedPort();
    const env = { ...process.env, PORT: String(port), TEST_GIFTS: '0' };
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
    assert.equal(stderr, '');
  });
}
