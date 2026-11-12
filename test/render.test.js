import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');

// Configuration regressions only, not a substitute for Render's Blueprint validator.
test('Render trial uses Free Node hosting, test-gated builds and dedicated liveness', () => {
  for (const line of [
    'type: web', 'runtime: node', 'plan: free',
    'buildCommand: npm ci --ignore-scripts && NODE_ENV=test npm test',
    'startCommand: npm start', 'healthCheckPath: /healthz',
  ]) assert.ok(blueprint.split('\n').some(value => value.trim().replace(/^- /, '') === line), line);
  assert.match(blueprint, /key: NODE_VERSION\n\s+value: "24"/);
  assert.match(blueprint, /key: NODE_ENV\n\s+value: production/);
  assert.match(blueprint, /key: HOST\n\s+value: 0\.0\.0\.0/);
  assert.match(blueprint, /key: TEST_GIFTS\n\s+value: "0"/);
  assert.match(blueprint, /key: ALLOWED_ORIGINS\n\s+sync: false/);
  assert.match(blueprint, /key: TRUSTED_PROXIES\n\s+value: ""/);
  assert.doesNotMatch(blueprint, /key: PORT\s/);
  assert.doesNotMatch(blueprint, /\b(?:databases|disk|scaling):/);
});
