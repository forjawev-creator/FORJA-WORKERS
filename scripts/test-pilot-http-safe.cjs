const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createRuntime } = require('./workers-test-runtime.cjs');
const root = path.resolve(__dirname, '..');
const ts = createRequire(path.join(process.env.WORKERS_TEST_DEPS || root, 'package.json'))('typescript');

async function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-pilot-http-'));
  const runtime = createRuntime(cwd);
  const state = { enabled: false, processRunning: false, reachable: false, providerStarts: 0, dials: 0 };
  const events = new EventEmitter(); events.broadcast = e => events.emit('ui-event', e);
  const token = 'test-token-'.repeat(8);
  const mocks = {
    'dotenv/config': {},
    './control-auth.js': runtime.load('src/control-auth.ts'),
    './runtime-policy.js': { runtimePolicy: () => ({ realCallsEnabled: state.enabled }) },
    './storage.js': { loadConfig: () => ({ geminiApiKey: 'synthetic-never-used' }) },
    './voice-server.js': { startVoiceBridge() { throw Error('No audio sockets in HTTP test'); } },
    './bridge-manager.js': { fetchBridgeHealth: async () => ({ processRunning: state.processRunning, reachable: state.reachable, registered: false, callActive: false }), fetchBridgeTelemetry: async () => ({ registered: false, call_active: false }), sendHttpNetelipCommand: async () => { state.dials++; throw Error('Dial forbidden'); } },
    './events.js': { appEvents: events },
    './engines/gemini-live-engine.js': { GeminiLiveEngine: class { constructor() { state.providerStarts++; throw Error('Provider forbidden'); } } },
    './pilot/probe-controller.js': runtime.load('src/pilot/probe-controller.ts'),
    './pilot/shutdown.js': runtime.load('src/pilot/shutdown.ts'),
    './pilot/journal.js': runtime.load('src/pilot/journal.ts'),
  };
  const allowedBuiltins = new Set(['node:http', 'node:fs', 'node:crypto', 'node:url']);
  const requireSafe = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'node:path') return { ...path, resolve: (...args) => path.resolve(cwd, ...args) };
    if (allowedBuiltins.has(name)) return require(name);
    throw Error('Unexpected dependency: ' + name);
  };
  // Exercise the exact HTTP factory, excluding only its executable bootstrap.
  const source = fs.readFileSync(path.join(root, 'src/pilot-entry.ts'), 'utf8').split('\nif (process.argv[1]')[0];
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: requireSafe, process: { cwd: () => cwd, env: { CALLS_PILOT: '1', CALL_ALLOWED_NUMBERS: '34900000000' } }, Buffer, URL, console, setTimeout, clearTimeout }, { filename: 'pilot-entry.ts' });
  const pilot = module.exports.createPilotServer();
  await new Promise(resolve => pilot.server.listen(0, '127.0.0.1', resolve));
  const port = pilot.server.address().port;
  function request(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers, agent: false }, res => { let text = ''; res.on('data', b => text += b); res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, data }); }); });
      req.on('error', reject); req.end(body);
    });
  }
  return { state, request, port, token, close: async () => { await new Promise(resolve => pilot.server.close(resolve)); runtime.dispose(); } };
}
test('HTTP: private status requires credentials, origin rejects cross-site and health separates control-only from failed bridge', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/status')).status, 401);
    assert.equal((await f.request('/healthz')).status, 200);
    const auth = { Authorization: 'Bearer ' + f.token };
    const status = await f.request('/api/status', { headers: auth });
    assert.equal(status.status, 200); assert.equal(status.data.controlOnly, true); assert.equal(status.data.ready, false);
    f.state.enabled = true;
    assert.equal((await f.request('/healthz')).status, 503);
    assert.equal((await f.request('/api/status', { headers: auth })).status, 200);
    f.state.processRunning = true; f.state.reachable = true;
    assert.equal((await f.request('/healthz')).status, 200);
    assert.equal((await f.request('/api/status', { headers: { ...auth, Host: 'evil.invalid' } })).status, 403);
    assert.equal((await f.request('/api/probe', { method: 'POST', headers: { ...auth, Origin: 'https://evil.invalid', 'X-Pilot-Action': '1' } })).status, 401);
    assert.equal((await f.request('/api/probe', { method: 'POST', headers: auth })).status, 403);
    f.state.enabled = false;
    assert.equal((await f.request('/api/probe', { method: 'POST', headers: { ...auth, 'X-Pilot-Action': '1' } })).status, 500);
    assert.equal(f.state.providerStarts, 0); assert.equal(f.state.dials, 0);
    const login = await f.request('/api/login', { method: 'POST', headers: { Origin: 'http://127.0.0.1:' + f.port, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: f.token }) });
    assert.equal(login.status, 200); assert.match(login.headers['set-cookie'][0], /HttpOnly/);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await f.request('/api/status', { headers: { Cookie: cookie } })).status, 200);
  } finally { await f.close(); }
});
