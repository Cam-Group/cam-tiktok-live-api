import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { normalizeEvent } from '../src/events.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function projectFiles(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.pi', '.git'].includes(entry.name)) return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? projectFiles(path) : [path];
  });
}
const markdown = projectFiles().filter(path => extname(path) === '.md');
const read = path => readFileSync(path, 'utf8');
const api = read(resolve(root, 'docs/client-api.md'));
const guide = read(resolve(root, 'docs/client-guide.md'));

// A focused regression for the previous project language, not a language classifier.
test('project-owned text contains no leftover Vietnamese diacritics', () => {
  const previousLanguage = /[\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]/u;
  for (const path of projectFiles().filter(path => ['.md', '.js', '.json'].includes(extname(path)))) {
    assert.equal(previousLanguage.test(read(path)), false, path);
  }
});

test('local documentation links and heading anchors resolve', () => {
  for (const path of markdown) {
    for (const match of read(path).matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const link = match[1];
      if (/^[a-z]+:/i.test(link)) continue;
      const [file, anchor] = link.split('#');
      const target = file ? resolve(dirname(path), decodeURIComponent(file)) : path;
      assert.ok(existsSync(target), `${path}: ${link}`);
      if (anchor) {
        const headings = [...read(target).matchAll(/^#{1,6}\s+(.+)$/gm)].map(match =>
          match[1].toLowerCase().replace(/[^\w\- ]/g, '').replace(/\s/g, '-'));
        assert.ok(headings.includes(anchor), `${path}: ${link}`);
      }
    }
  }
});

test('documented JavaScript, shell and JSON blocks are syntactically valid', () => {
  for (const path of markdown) {
    for (const match of read(path).matchAll(/^```(js|sh|json)\n([\s\S]*?)^```/gm)) {
      const [, language, code] = match;
      if (language === 'json') { assert.doesNotThrow(() => JSON.parse(code), path); continue; }
      const command = language === 'js' ? process.execPath : '/bin/sh';
      const args = language === 'js' ? ['--input-type=module', '--check'] : ['-n'];
      const result = spawnSync(command, args, { input: code, encoding: 'utf8' });
      assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    }
  }
});

test('complete API examples match the current normalized payload keys', () => {
  for (const type of ['status', 'chat', 'gift', 'like', 'follow', 'share', 'join', 'viewers']) {
    const section = api.split(`### ${type}\n`)[1]?.split('\n### ')[0].split('\n## ')[0];
    assert.ok(section, `Missing documentation section: ${type}`);
    const json = section.match(/```json\n([\s\S]*?)```/);
    assert.ok(json, `Missing complete JSON example: ${type}`);
    const event = JSON.parse(json[1]);
    const actual = type === 'status' ? { text: '' } : normalizeEvent(type, { isStreakOver: true, diamondTotal: 1 });
    assert.deepEqual(Object.keys(event).sort(), Object.keys(actual).sort(), type);
    if (actual.user) assert.deepEqual(Object.keys(event.user).sort(), Object.keys(actual.user).sort(), `${type}.user`);
    if (type !== 'status') {
      assert.equal(typeof event.eventId, 'string');
      assert.equal(typeof event.roomId, 'string');
      assert.ok(Number.isSafeInteger(event.ts));
    }
  }
});

test('browser subscription example handles named events, reconnect state and explicit cleanup', () => {
  const code = guide.match(/```js\n([\s\S]*?)```/)[1];
  const calls = [];
  class FakeEventSource {
    static CLOSED = 2;
    static instance;
    readyState = 1;
    listeners = new Map();
    constructor(url) { this.url = String(url); FakeEventSource.instance = this; }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    close() { this.readyState = FakeEventSource.CLOSED; }
  }
  const context = vm.createContext({ URL, EventSource: FakeEventSource, console: { log: (...args) => calls.push(args), error: (...args) => calls.push(args) } });
  vm.runInContext(code, context);
  const source = FakeEventSource.instance;
  assert.equal(new URL(source.url).searchParams.get('username'), 'your_username');
  assert.equal(source.listeners.size, 8);
  source.onopen();
  source.listeners.get('chat')({ data: JSON.stringify({ user: { nickname: 'Alice' }, text: 'Hello 👋' }) });
  source.listeners.get('viewers')({ data: JSON.stringify({ viewerCount: 0 }) });
  source.listeners.get('like')({ data: 'invalid-json' });
  source.onerror();
  vm.runInContext('stop()', context);
  assert.ok(calls.some(args => args[0] === 'Alice' && args[1] === 'Hello 👋'));
  assert.ok(calls.some(args => args[0] === 'Viewers:' && args[1] === 0));
  assert.ok(calls.some(args => args[0] === 'Backend transport:' && args[1] === 'reconnecting'));
  assert.equal(source.readyState, FakeEventSource.CLOSED);
  assert.equal(calls.at(-1)[1], 'closed');
});

test('documented duplicate filter is bounded and accepts events with missing IDs', () => {
  const blocks = [...guide.matchAll(/```js\n([\s\S]*?)```/g)];
  const code = blocks.find(match => match[1].includes('function createDuplicateFilter'))[1];
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const duplicate = vm.runInContext('createDuplicateFilter(2)', context);
  const event = eventId => ({ roomId: '1', eventId });
  assert.equal(duplicate('alice', 'gift', event('1')), false);
  assert.equal(duplicate('alice', 'gift', event('1')), true);
  assert.equal(duplicate('bob', 'gift', event('1')), false);
  assert.equal(duplicate('alice', 'chat', event('1')), false);
  assert.equal(duplicate('alice', 'gift', event('1')), false);
  assert.equal(duplicate('alice', 'gift', event('')), false);
  assert.equal(duplicate('alice', 'gift', event('')), false);
});
