import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendEnv, configured } from '../test-support/backend-env.js';

const read = keys => Object.fromEntries(keys.map(key => [key, process.env[key]]));
function restore(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('backend fixtures ignore deployed quotas, proxy identity, origins and bind settings', () => {
  const ambient = {
    NODE_ENV: 'production', HOST: 'invalid-host', PORT: 'invalid-port',
    ALLOWED_ORIGINS: 'https://game.example/', TEST_GIFTS: '1',
    MAX_CLIENTS: '1', MAX_CLIENTS_PER_IP: '1', REQUESTS_PER_MINUTE: '1', GLOBAL_REQUESTS_PER_MINUTE: '1',
    TRUSTED_PROXIES: '*', CLIENT_IP_HEADER: 'invalid-header',
  };
  const previous = read(Object.keys(ambient));
  try {
    Object.assign(process.env, ambient);
    const env = backendEnv({ PORT: '1234' });
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.PORT, '1234');
    assert.equal(env.PATH, process.env.PATH);
    for (const key of Object.keys(ambient).filter(key => !['NODE_ENV', 'PORT'].includes(key))) {
      assert.equal(env[key], undefined, key);
    }
    assert.deepEqual(read(Object.keys(ambient)), ambient, 'building a child environment does not mutate its parent');
    const failure = new Error('fixture failure');
    assert.throws(() => configured({ MAX_CLIENTS: '2' }, () => {
      assert.equal(process.env.MAX_CLIENTS, '2');
      assert.equal(process.env.MAX_CLIENTS_PER_IP, undefined);
      assert.equal(process.env.ALLOWED_ORIGINS, undefined);
      throw failure;
    }), error => error === failure);
    assert.deepEqual(read(Object.keys(ambient)), ambient, 'all values survive a failing fixture');
  } finally { restore(previous); }
});

test('nested fixtures restore the enclosing environment', () => {
  const before = process.env.MAX_CLIENTS;
  configured({ MAX_CLIENTS: '2' }, () => {
    configured({ MAX_CLIENTS: '3' }, () => assert.equal(process.env.MAX_CLIENTS, '3'));
    assert.equal(process.env.MAX_CLIENTS, '2');
  });
  assert.equal(process.env.MAX_CLIENTS, before);
});
