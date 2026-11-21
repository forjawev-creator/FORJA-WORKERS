const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('./workers-test-runtime.cjs');

test('Windows exclusive lock retries temporary sharing failures and preserves permanent permission errors', { skip: process.platform !== 'win32' }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-lock-windows-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  const file = path.join(cwd, 'data', 'counter.json');
  fs.writeFileSync(file, '{"count":0}');
  let failuresLeft = 2, attempts = 0, updates = 0;
  const denied = Object.assign(new Error('synthetic permission failure'), { code: 'EPERM' });
  const wrapped = new Proxy(fs, { get(target, key) {
    if (key !== 'openSync') return target[key];
    return (...args) => {
      if (args[0] === file + '.lock' && args[1] === 'wx') {
        attempts++;
        if (failuresLeft > 0) { failuresLeft--; throw denied; }
      }
      return target.openSync(...args);
    };
  } });
  const runtime = createRuntime(cwd, { '@module:fs': wrapped });
  try {
    const { atomicUpdateJson } = runtime.load('src/storage.ts');
    const update = value => { updates++; return { count: value.count + 1 }; };
    atomicUpdateJson(file, update);
    assert.equal(attempts, 3); assert.equal(updates, 1);
    assert.equal(JSON.parse(fs.readFileSync(file)).count, 1);
    assert.equal(fs.existsSync(file + '.lock'), false);
    failuresLeft = Number.MAX_SAFE_INTEGER;
    assert.throws(() => atomicUpdateJson(file, update), error => error === denied);
    assert.equal(updates, 1); assert.equal(JSON.parse(fs.readFileSync(file)).count, 1);
    assert.equal(fs.existsSync(file + '.lock'), false);
  } finally { runtime.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('an apparently stale lock is never removed automatically while another writer could replace it', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-lock-stale-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  const file = path.join(cwd, 'data', 'counter.json');
  fs.writeFileSync(file, '{"count":7}');
  const foreignLock = '2147483647\n1';
  fs.writeFileSync(file + '.lock', foreignLock);
  const runtime = createRuntime(cwd);
  try {
    const { atomicUpdateJson } = runtime.load('src/storage.ts');
    assert.throws(() => atomicUpdateJson(file, () => ({ count: 8 })), /bloqueo/);
    assert.equal(fs.readFileSync(file + '.lock', 'utf8'), foreignLock);
    assert.equal(JSON.parse(fs.readFileSync(file)).count, 7);
  } finally { runtime.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
