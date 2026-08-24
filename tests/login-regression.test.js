'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-login-'));
process.env.DATA_PATH = path.join(tempDir, 'db.json');
process.env.PORT = '0';
process.env.DEVICE_TOKEN = 'test-device';
process.env.JWT_SECRET = 'test-secret';

const { server } = require('../backend/server');
let origin;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(origin + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return { status: response.status, body: await response.json() };
}

test('browser freshness helper is served as JavaScript before app.js', async () => {
  const response = await fetch(origin + '/hanger-freshness.js');
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /javascript/);
  assert.notEqual(body.trimStart().charAt(0), '<');
  assert.match(body, /createTracker/);

  const index = fs.readFileSync(path.join(root, 'web/public/index.html'), 'utf8');
  assert.ok(index.indexOf('/hanger-freshness.js') < index.indexOf('/app.js'));

  const helper = require('../web/public/hanger-freshness.js');
  const tracker = helper.createTracker();
  assert.equal(typeof helper.createTracker, 'function');
  assert.equal(typeof helper.hangerIdOf, 'function');
  assert.equal(typeof tracker.hangerIdOf, 'function');
  assert.equal(typeof tracker.isFresher, 'function');
  assert.equal(typeof tracker.clothingStatus, 'function');
});

test('login uses POST and the handler prevents native GET navigation', async () => {
  const app = fs.readFileSync(path.join(root, 'web/public/app.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'web/public/index.html'), 'utf8');
  assert.match(index, /id="authForm"/);
  assert.match(app, /authFormElement\.method\s*=\s*'post'/);
  assert.match(app, /authFormElement\.action\s*=\s*'\/'/);
  assert.match(app, /\$\('#authForm'\)\.onsubmit\s*=\s*async e/);
  assert.match(app, /e\.preventDefault\(\)/);
  assert.match(app, /api\('\/api\/auth\/' \+ mode, \{ method: 'POST'/);
  assert.match(app, /await enter\(\)/);

  const email = `login-${Date.now()}@example.com`;
  let result = await jsonRequest('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name: 'Login Test', email, password: '0123456789' }),
  });
  assert.equal(result.status, 201);
  result = await jsonRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: '0123456789' }),
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.token);

  const snapshot = await jsonRequest('/api/snapshot', {
    headers: { authorization: 'Bearer ' + result.body.token },
  });
  assert.equal(snapshot.status, 200);
  assert.ok(Array.isArray(snapshot.body.garments));
  assert.ok(Array.isArray(snapshot.body.hangers));
  assert.ok(Array.isArray(snapshot.body.gateways));

  assert.match(app, /model\s*=\s*mergeSnapshot\(await api\('\/api\/snapshot'\)\)/);
  assert.match(app, /\$\('#auth'\)\.hidden\s*=\s*true/);
  assert.match(app, /\$\('#app'\)\.hidden\s*=\s*false/);
});
