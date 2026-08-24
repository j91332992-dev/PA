'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wardrobe-link-loss-'));
process.env.DATA_PATH = path.join(tmp, 'db.json');
process.env.PORT = '0';
process.env.DEVICE_TOKEN = 'link-loss-device';
process.env.JWT_SECRET = 'link-loss-secret';
// Keep the automated proof fast; production defaults to 900ms.
process.env.HANGER_OFFLINE_TIMEOUT_MS = '80';
const { server } = require('../backend/server');

let origin, token;
async function call(route, options = {}) {
  const response = await fetch(origin + route, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const signup = await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name: '통신검증', email: 'link-loss@example.com', password: '0123456789' }),
  });
  token = signup.body.token;
  await call('/api/garments', {
    method: 'POST', headers: { authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: '통신 단절 옷', tagUid: '04A1B2C3D4E5F6' }),
  });
});

test.after(() => server.close());

test('lost C6 ESP-NOW heartbeat makes the garment OUT and cancels FIND', async () => {
  let response = await call('/api/gateway/status', {
    method: 'POST', headers: { authorization: 'Bearer link-loss-device' },
    body: JSON.stringify({ gatewayId: 'GW-ABCDEF', hangerId: 'HC-ABCDEF', state: 'PRESENT', tagUid: '04A1B2C3D4E5F6', sequence: 1, bootId: 'link-loss-boot' }),
  });
  assert.equal(response.status, 200);
  response = await call('/api/gateways/GW-ABCDEF/claim', {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: '{}',
  });
  assert.equal(response.status, 200);
  response = await call('/api/hangers/HC-ABCDEF/claim', {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: '{}',
  });
  assert.equal(response.status, 200);
  response = await call('/api/commands', {
    method: 'POST', headers: { authorization: 'Bearer ' + token },
    body: JSON.stringify({ targets: ['HC-ABCDEF'], command: 'LED_BLINK' }),
  });
  assert.equal(response.status, 202);
  await new Promise(resolve => setTimeout(resolve, 260));
  response = await call('/api/snapshot', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.body.garments[0].currentState, 'OUT');
  assert.equal(response.body.garments[0].currentHanger, null);
  assert.equal(response.body.commands[0].status, 'CANCELLED');
});
