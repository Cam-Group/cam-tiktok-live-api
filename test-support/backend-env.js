// Own only the application's variables; preserve PATH and the test runner's environment.
const keys = [
  'NODE_ENV', 'HOST', 'PORT', 'ALLOWED_ORIGINS', 'TEST_GIFTS',
  'MAX_CLIENTS', 'MAX_CLIENTS_PER_IP', 'REQUESTS_PER_MINUTE', 'GLOBAL_REQUESTS_PER_MINUTE',
  'TRUSTED_PROXIES', 'CLIENT_IP_HEADER',
];

export function backendEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return { ...env, NODE_ENV: 'test', ...overrides };
}

export function configured(overrides, fn) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const env = backendEnv(overrides);
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
