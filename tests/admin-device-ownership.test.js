'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-admin-device-'));
const dataPath = path.join(tempDir, 'wardrobe.json');
const adminEmail = 'admin-device@example.com';
const password = 'admin-device-password';
const salt = '0123456789abcdef0123456789abcdef';
const passwordHash = `${salt}:${crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')}`;

fs.writeFileSync(dataPath, JSON.stringify({
  schemaVersion: 4,
  users: [{ id: 'usr_admin', email: adminEmail, name: '운영관리자', passwordHash, role: 'user', createdAt: new Date().toISOString() }],
  wardrobes: [{ id: 'wd_admin', userId: 'usr_admin', name: '운영관리자의 스마트 옷장', createdAt: new Date().toISOString() }],
  gateways: [{ gatewayId: 'GW-ADMIN01', wardrobeId: 'wd_admin', name: '운영관리자의 1번 옷봉', customName: '', createdAt: new Date().toISOString() }],
  hangers: [{ hangerId: 'HC-ADMIN01', wardrobeId: 'wd_admin', gatewayId: 'GW-ADMIN01', alias: '1번 옷걸이', customName: '', createdAt: new Date().toISOString() }],
  garments: [], events: [], commands: []
}));

process.env.DATA_PATH = dataPath;
process.env.ADMIN_EMAIL = adminEmail;
process.env.ADMIN_SECONDARY_PASSWORD = 'admin-secondary';
process.env.JWT_SECRET = 'admin-device-test-secret';
process.env.DEVICE_TOKEN = 'admin-device-test-device';
process.env.DISABLE_BACKGROUND_TASKS = 'true';

const { server } = require('../backend/server');
let baseUrl = '';

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.adminSession ? { 'x-admin-session': options.adminSession } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('legacy admin-owned physical hardware is released, and a verified admin can recover a newly misassigned gateway', async () => {
  const login = await request('/api/auth/login', { method: 'POST', body: { email: adminEmail, password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');

  const freshHardware = await request('/api/gateway/status', {
    method: 'POST', token: 'admin-device-test-device', body: {
      gatewayId: 'GW-A1B2C3', hangerId: 'HC-A1B2C3', state: 'EMPTY',
      sequence: 1, bootId: 'fresh-hardware'
    }
  });
  assert.equal(freshHardware.status, 200);

  const ordinary = await request('/api/auth/signup', { method: 'POST', body: { email: 'ordinary-device@example.com', password: 'ordinary-password', name: '일반장비사용자' } });
  assert.equal(ordinary.status, 201);
  const freshPairing = await request('/api/gateways/GW-A1B2C3/pairing-status', { token: ordinary.body.token });
  assert.equal(freshPairing.body.ownership, 'UNCLAIMED');
  const legacyPairing = await request('/api/gateways/GW-ADMIN01/pairing-status', { token: ordinary.body.token });
  assert.equal(legacyPairing.body.ownership, 'UNCLAIMED');

  const verify = await request('/api/admin/verify', { method: 'POST', token: login.body.token, body: { password: 'admin-secondary' } });
  assert.equal(verify.status, 200);
  const claim = await request('/api/gateways/GW-ADMIN01/claim', { method: 'POST', token: login.body.token });
  assert.equal(claim.status, 200);
  const hangerClaim = await request('/api/hangers/HC-ADMIN01/claim', { method: 'POST', token: login.body.token });
  assert.equal(hangerClaim.status, 200);
  const release = await request('/api/admin/gateways/GW-ADMIN01/release', { method: 'POST', token: login.body.token, adminSession: verify.body.adminSession });
  assert.equal(release.status, 200);
  assert.deepEqual(release.body.releasedHangers, ['HC-ADMIN01']);

  const recoveredPairing = await request('/api/gateways/GW-ADMIN01/pairing-status', { token: ordinary.body.token });
  assert.equal(recoveredPairing.body.ownership, 'UNCLAIMED');
});
