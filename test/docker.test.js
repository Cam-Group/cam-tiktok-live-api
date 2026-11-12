import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 5000 }).status === 0;

test('Compose config keeps host publishing private and simulation disabled', { skip: !composeAvailable }, () => {
  const result = spawnSync('docker', ['compose', '-f', 'compose.yaml', 'config', '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PORT: '3200', ALLOWED_ORIGINS: 'https://game.example', TEST_GIFTS: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const service = JSON.parse(result.stdout).services.backend;
  assert.equal(service.ports.length, 1);
  assert.equal(service.ports[0].host_ip, '127.0.0.1');
  assert.equal(service.ports[0].published, '3200');
  assert.equal(service.ports[0].target, 3100);
  assert.equal(service.environment.TEST_GIFTS, '0');
  assert.equal(service.environment.ALLOWED_ORIGINS, 'https://game.example');
  assert.equal(service.init, true);
  assert.equal(service.restart, 'unless-stopped');
  assert.equal(service.logging.options['max-size'], '10m');
  assert.equal(service.logging.options['max-file'], '3');
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.equal(service.pids_limit, 64);
  assert.equal(service.mem_limit, '536870912');
  assert.equal(Number(service.cpus), 1);
  assert.equal(service.environment.MAX_CLIENTS, '100');
  assert.equal(service.environment.MAX_CLIENTS_PER_IP, '5');
});
