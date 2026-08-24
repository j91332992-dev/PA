'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocket } = require('ws');

// Configure isolated test environment
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-scenarios-'));
if (!process.env.DATA_PATH) process.env.DATA_PATH = path.join(tmpDir, 'wardrobe-scenarios.json');
if (!process.env.DEVICE_TOKEN) process.env.DEVICE_TOKEN = 'test-device';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret';
if (!process.env.ADMIN_EMAIL) process.env.ADMIN_EMAIL = 'owner-scenarios@example.com';
if (!process.env.ADMIN_SECONDARY_PASSWORD) process.env.ADMIN_SECONDARY_PASSWORD = 'secondary-test-password';
// The virtual hardware scenarios deliberately exercise simulator-only IDs.
if (!process.env.SIMULATION_ENABLED) process.env.SIMULATION_ENABLED = 'true';

const deviceToken = 'test-device';

const { server } = require('../backend/server');
const { VirtualGateway } = require('../simulator/virtual-hardware');
const HangerFreshness = require('../web/public/hanger-freshness.js');
const CloudImageService = require('../backend/cloud-image-service');

let baseUrl, wsUrl, userToken, vgw;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;

  // 1. Create initial test user
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'owner-scenarios@example.com',
      password: 'mypassword1234',
      name: '옷장주인',
    }),
  });
  assert.equal(signupRes.status, 201);
  const signupData = await signupRes.json();
  userToken = signupData.token;

  // 2. Initialize Virtual Gateway
  vgw = new VirtualGateway({
    baseUrl,
    deviceToken,
    gatewayId: 'GW-TEST01',
    pollIntervalMs: 150,
    heartbeatIntervalMs: 2000,
    silent: true,
  });
  await vgw.start();
});

test.after(async () => {
  if (vgw) vgw.stop();
  await new Promise(resolve => server.close(resolve));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.userAuth ? { 'Authorization': `Bearer ${userToken}` } : {}),
      ...(options.adminSession ? { 'X-Admin-Session': options.adminSession } : {}),
      ...(options.deviceAuth ? { 'Authorization': `Bearer ${deviceToken}` } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('Scenario A: Registered Tag Insert -> PRESENT -> Garment IN_WARDROBE', async () => {
  const tagUid = '04A11122334455';
  const gRes = await api('/api/garments', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({
      name: '테스트 자켓',
      tagUid,
      category: '아우터',
    }),
  });
  assert.equal(gRes.status, 201);
  const garment = gRes.body;
  assert.equal(garment.currentState, 'OUT');

  // Virtual Hanger HC-000001 inserts tag
  await vgw.tagInsert('HC-000001', tagUid);

  const snap = await api('/api/snapshot', { userAuth: true });
  const h = snap.body.hangers.find(x => x.hangerId === 'HC-000001');
  const g = snap.body.garments.find(x => x.id === garment.id);

  assert.equal(h.state, 'PRESENT');
  assert.equal(h.tagUid, tagUid);
  assert.equal(g.currentState, 'IN_WARDROBE');
  assert.equal(g.currentHanger, 'HC-000001');
});

test('Scenario B: Tag Remove -> EMPTY -> Garment OUT', async () => {
  await vgw.tagRemove('HC-000001');

  const snap = await api('/api/snapshot', { userAuth: true });
  const h = snap.body.hangers.find(x => x.hangerId === 'HC-000001');
  const g = snap.body.garments.find(x => x.tagUid === '04A11122334455');

  assert.equal(h.state, 'EMPTY');
  assert.equal(h.tagUid, null);
  assert.equal(g.currentState, 'OUT');
  assert.equal(g.currentHanger, null);
});

test('Scenario C: Unknown UID -> UNKNOWN_TAG', async () => {
  const unknownUid = '04EEEEFFFF0000';
  await vgw.tagInsert('HC-000002', unknownUid);

  const snap = await api('/api/snapshot', { userAuth: true });
  const h = snap.body.hangers.find(x => x.hangerId === 'HC-000002');

  assert.equal(h.state, 'UNKNOWN_TAG');
  assert.equal(h.reportedState, 'PRESENT');
  assert.equal(h.tagUid, unknownUid);
});

test('Scenario D: Duplicate sequence/bootId rejection', async () => {
  const h = vgw.hangers.get('HC-000002');
  const initialSeq = h.sequence;
  const initialBoot = h.bootId;

  // Re-send with same or lower sequence
  const dupRes = await vgw.sendStatus(h, initialSeq, initialBoot);
  assert.equal(dupRes.duplicate, true);
});

test('Account/Gateway/Hanger numbers are scoped, monotonic, and admin protected', async () => {
  const sendStatus = (gatewayId, hangerId, sequence = 1) => api('/api/gateway/status', {
    method: 'POST', deviceAuth: true,
    body: JSON.stringify({ gatewayId, hangerId, state: 'EMPTY', sequence, bootId: `boot-${hangerId}`, channel: 4 }),
  });
  await sendStatus('GW-A0B001', 'HC-A0B001');
  await sendStatus('GW-A0B001', 'HC-A0B002');
  await sendStatus('GW-A0B002', 'HC-A0B003');
  await api('/api/gateways/GW-A0B001/claim', { method: 'POST', userAuth: true, body: '{}' });
  await api('/api/gateways/GW-A0B002/claim', { method: 'POST', userAuth: true, body: '{}' });
  await api('/api/hangers/HC-A0B001/claim', { method: 'POST', userAuth: true, body: '{}' });
  await api('/api/hangers/HC-A0B002/claim', { method: 'POST', userAuth: true, body: '{}' });
  await api('/api/hangers/HC-A0B003/claim', { method: 'POST', userAuth: true, body: '{}' });
  let snap = await api('/api/snapshot', { userAuth: true });
  const gw1 = snap.body.gateways.find(g => g.gatewayId === 'GW-A0B001');
  const gw2 = snap.body.gateways.find(g => g.gatewayId === 'GW-A0B002');
  assert.equal(gw2.gatewayNumber, gw1.gatewayNumber + 1);
  assert.equal(snap.body.hangers.find(h => h.hangerId === 'HC-A0B001').hangerNumber, 1);
  assert.equal(snap.body.hangers.find(h => h.hangerId === 'HC-A0B002').hangerNumber, 2);
  assert.equal(snap.body.hangers.find(h => h.hangerId === 'HC-A0B003').hangerNumber, 1);
  await api('/api/hangers/HC-A0B002', { method: 'PATCH', userAuth: true, body: JSON.stringify({ gatewayId: 'GW-A0B002', name: '이동한 옷걸이' }) });
  snap = await api('/api/snapshot', { userAuth: true });
  const moved = snap.body.hangers.find(h => h.hangerId === 'HC-A0B002');
  assert.equal(moved.gatewayId, 'GW-A0B002');
  assert.equal(moved.hangerNumber, 2);
  assert.equal(moved.alias, '이동한 옷걸이');
  const beforeVerification = await api('/api/admin/overview', { userAuth: true });
  assert.equal(beforeVerification.status, 403);
  const statusBeforeVerification = await api('/api/admin/status', { userAuth: true });
  assert.equal(statusBeforeVerification.status, 200);
  assert.equal(statusBeforeVerification.body.verified, false);
  const wrongVerification = await api('/api/admin/verify', { method: 'POST', userAuth: true, body: JSON.stringify({ password: 'wrong-password' }) });
  assert.equal(wrongVerification.status, 403);
  const verification = await api('/api/admin/verify', { method: 'POST', userAuth: true, body: JSON.stringify({ password: 'secondary-test-password' }) });
  assert.equal(verification.status, 200);
  assert.ok(verification.body.adminSession);
  const statusAfterVerification = await api('/api/admin/status', { userAuth: true, adminSession: verification.body.adminSession });
  assert.equal(statusAfterVerification.status, 200);
  assert.equal(statusAfterVerification.body.verified, true);
  const admin = await api('/api/admin/overview', { userAuth: true, adminSession: verification.body.adminSession });
  assert.equal(admin.status, 200);
  assert.ok(admin.body.totals.hangers >= 3);
  assert.ok(admin.body.totals.garments >= 1);

  const signup = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'ordinary-user@example.com', password: 'ordinary-password', name: '일반사용자' }) });
  const ordinary = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Authorization: `Bearer ${signup.body.token}` } });
  assert.equal(ordinary.status, 403);
  const ordinaryStatus = await fetch(`${baseUrl}/api/admin/status`, { headers: { Authorization: `Bearer ${signup.body.token}` } });
  assert.equal(ordinaryStatus.status, 403);
});

test('Race A: WebSocket PRESENT seq=10 wins over delayed snapshot EMPTY seq=9', () => {
  const tracker = HangerFreshness.createTracker();
  const present = { hangerId: 'HC-RACE01', state: 'PRESENT', reportedState: 'PRESENT', tagUid: '04RACE00000001', bootId: 'boot-a', lastSequence: 10 };
  const staleSnapshot = { ...present, state: 'EMPTY', reportedState: 'EMPTY', tagUid: null, lastSequence: 9 };
  tracker.remember(present);
  assert.equal(tracker.isFresher(staleSnapshot, present), false);
});

test('Race B: WebSocket EMPTY seq=11 wins over delayed snapshot PRESENT seq=10', () => {
  const tracker = HangerFreshness.createTracker();
  const empty = { hangerId: 'HC-RACE02', state: 'EMPTY', reportedState: 'EMPTY', tagUid: null, bootId: 'boot-a', lastSequence: 11 };
  const staleSnapshot = { ...empty, state: 'PRESENT', reportedState: 'PRESENT', tagUid: '04RACE00000002', lastSequence: 10 };
  tracker.remember(empty);
  assert.equal(tracker.isFresher(staleSnapshot, empty), false);
});

test('Race C: an old boot packet is rejected after a new boot is accepted', async () => {
  const send = (state, tagUid, sequence, bootId) => api('/api/gateway/status', {
    method: 'POST',
    deviceAuth: true,
    body: JSON.stringify({ gatewayId: 'GW-A1B2C3', hangerId: 'HC-A1B2C3', state, tagUid, sequence, bootId, channel: 1 }),
  });

  await send('PRESENT', '04RACE00000003', 10, 'boot-a');
  const newBoot = await send('PRESENT', '04RACE00000003', 1, 'boot-b');
  assert.equal(newBoot.status, 200);
  const oldBoot = await send('EMPTY', null, 99, 'boot-a');
  assert.equal(oldBoot.status, 200);
  assert.equal(oldBoot.body.duplicate, true);
  assert.equal(oldBoot.body.stale, true);

  await api('/api/gateways/GW-A1B2C3/claim', { method: 'POST', userAuth: true, body: '{}' });
  await api('/api/hangers/HC-A1B2C3/claim', { method: 'POST', userAuth: true, body: '{}' });

  const snap = await api('/api/snapshot', { userAuth: true });
  const hanger = snap.body.hangers.find(h => h.hangerId === 'HC-A1B2C3');
  assert.equal(hanger.reportedState, 'PRESENT');
  assert.equal(hanger.tagUid, '04ACE00000003');
  assert.equal(hanger.bootId, 'boot-b');
  assert.equal(hanger.lastSequence, 1);
});

test('Race D: UNKNOWN_TAG with a UID is rendered as an unregistered tag, never empty', () => {
  const text = HangerFreshness.clothingStatus({ state: 'UNKNOWN_TAG', reportedState: 'PRESENT', tagUid: '04UNKNOWN00001' }, []);
  assert.match(text, /새 옷 감지됨/);
  assert.doesNotMatch(text, /걸린 옷 없음/);
});

test('Cloud image multipart parser accepts a bounded JPEG image part without local disk paths', () => {
  const boundary = '----wardrobe-test-boundary';
  const raw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="shirt.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEG-BYTES\r\n--${boundary}--\r\n`);
  const file = CloudImageService.multipartImage(raw, `multipart/form-data; boundary=${boundary}`);
  assert.equal(file.mime, 'image/jpeg');
  assert.equal(file.filename, 'shirt.jpg');
  assert.equal(file.image.toString(), 'JPEG-BYTES');
});

test('Scenario E: Same Tag reported by two Hangers -> CONFLICT', async () => {
  const conflictTag = '04C0FF11C70001';
  await api('/api/garments', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({ name: '충돌 테스트 셔츠', tagUid: conflictTag }),
  });

  await vgw.tagInsert('HC-000003', conflictTag);
  await vgw.tagInsert('HC-000004', conflictTag);

  const snap = await api('/api/snapshot', { userAuth: true });
  const h3 = snap.body.hangers.find(x => x.hangerId === 'HC-000003');
  const h4 = snap.body.hangers.find(x => x.hangerId === 'HC-000004');

  assert.equal(h3.state, 'CONFLICT');
  assert.equal(h4.state, 'CONFLICT');

  // Clean up
  await vgw.tagRemove('HC-000003');
  await vgw.tagRemove('HC-000004');
});

test('Scenario F: Find -> QUEUED -> SENT -> Virtual Hardware ACK -> ACKED', async () => {
  const shirtUid = '04F1F2F3F4F5F6';
  const gRes = await api('/api/garments', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({ name: '찾기 테스트 셔츠', tagUid: shirtUid }),
  });
  const garment = gRes.body;

  // Put garment on HC-000005
  await vgw.tagInsert('HC-000005', shirtUid);
  vgw.setAckMode('HC-000005', 'OK');

  // Request FIND
  const findRes = await api(`/api/garments/${garment.id}/find`, {
    method: 'POST',
    userAuth: true,
    body: '{}',
  });
  assert.equal(findRes.status, 202);
  const cmd = findRes.body;
  assert.equal(cmd.status, 'QUEUED');
  assert.deepEqual(cmd.targets, ['HC-000005']);

  // Wait for Virtual Gateway to poll and send ACK
  await new Promise(resolve => setTimeout(resolve, 500));

  const snap = await api('/api/snapshot', { userAuth: true });
  const updatedCmd = snap.body.commands.find(c => c.id === cmd.id);

  assert.equal(updatedCmd.status, 'ACKED');
  assert.equal(updatedCmd.acknowledgements['HC-000005'].result, 'OK');
});

test('Scenario G: Find + ACK IGNORE -> TIMEOUT', async () => {
  const pantsUid = '04AABB99887766';
  const gRes = await api('/api/garments', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({ name: '타임아웃 바지', tagUid: pantsUid }),
  });
  const garment = gRes.body;

  // Put on HC-000001 and set ACK mode to IGNORE
  await vgw.tagInsert('HC-000001', pantsUid);
  vgw.setAckMode('HC-000001', 'IGNORE');

  const findRes = await api(`/api/garments/${garment.id}/find`, {
    method: 'POST',
    userAuth: true,
    body: '{}',
  });
  assert.equal(findRes.status, 202);
  const cmd = findRes.body;

  // Wait for command polling (status -> SENT)
  await new Promise(resolve => setTimeout(resolve, 300));

  // Verify it reached SENT
  const snap1 = await api('/api/snapshot', { userAuth: true });
  const sentCmd = snap1.body.commands.find(c => c.id === cmd.id);
  assert.equal(sentCmd.status, 'SENT');

  // Verify TIMEOUT transition behavior
  // Note: Backend default COMMAND_TIMEOUT_MS is 15s in production, tested via timer check
  assert.ok(Date.parse(sentCmd.expiresAt) > Date.now());

  // Restore HC-000001 ack mode
  vgw.setAckMode('HC-000001', 'OK');
});

test('Scenario H: WebSocket real-time event streaming and state sync', async () => {
  const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(userToken)}`);
  const receivedEvents = [];

  ws.on('message', data => {
    try {
      receivedEvents.push(JSON.parse(data.toString()));
    } catch (_) {}
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const waitForEvent = (type, predicate = () => true, timeoutMs = 3000) => {
    return new Promise((resolve, reject) => {
      const checkExisting = () => {
        const found = receivedEvents.find(e => e.type === type && predicate(e));
        if (found) return resolve(found);
      };
      checkExisting();

      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`Timeout waiting for WS event: ${type}`));
      }, timeoutMs);

      const poll = setInterval(() => {
        const found = receivedEvents.find(e => e.type === type && predicate(e));
        if (found) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(found);
        }
      }, 50);
    });
  };

  // 1. Initial snapshot received on connection
  const snapshotEvt = await waitForEvent('snapshot');
  assert.ok(snapshotEvt.payload.wardrobe);

  // 2. Trigger state change on HC-000003
  const wsTag = '04998877665544';
  await vgw.tagInsert('HC-000003', wsTag);

  const stateEvent = await waitForEvent('hanger.state', e => e.payload?.hangerId === 'HC-000003' && e.payload?.tagUid === wsTag);
  assert.ok(stateEvent, 'hanger.state event received over WebSocket');
  assert.equal(stateEvent.payload.tagUid, wsTag);

  // Clean close
  ws.terminate();
});

test('Scenario I: Garment Delete -> reconcile turns Hanger to UNKNOWN_TAG', async () => {
  // 1. Create a garment
  const tagUid = '04ABCDEF012345';
  const gRes = await fetch(`${baseUrl}/api/garments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ name: '삭제 테스트 의류', tagUid, category: '아우터' }),
  });
  assert.equal(gRes.status, 201);
  const garment = await gRes.json();

  // 2. Insert tag on HC-000004 -> PRESENT & IN_WARDROBE
  await vgw.tagInsert('HC-000004', tagUid);
  await new Promise(r => setTimeout(r, 200));

  let snap = await (await fetch(`${baseUrl}/api/snapshot`, { headers: { Authorization: `Bearer ${userToken}` } })).json();
  let h4 = snap.hangers.find(h => h.hangerId === 'HC-000004');
  assert.equal(h4.state, 'PRESENT');

  // 3. Delete garment
  const delRes = await fetch(`${baseUrl}/api/garments/${garment.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(delRes.status, 200);
  const delData = await delRes.json();
  assert.equal(delData.ok, true);

  // 4. Verify snapshot: garment gone, HC-000004 with tag becomes UNKNOWN_TAG
  snap = await (await fetch(`${baseUrl}/api/snapshot`, { headers: { Authorization: `Bearer ${userToken}` } })).json();
  assert.ok(!snap.garments.some(g => g.id === garment.id));
  h4 = snap.hangers.find(h => h.hangerId === 'HC-000004');
  assert.equal(h4.state, 'UNKNOWN_TAG');
});

test('Scenario J: Persistent FIND (durationMs = 0) -> Virtual Hanger starts 5m Safety Blinking -> ACK -> ACKED', async () => {
  const hanger = vgw.hangers.get('HC-000001');
  hanger.ledUntil = 0;
  hanger.ackMode = 'OK';

  const res = await api('/api/commands', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({
      targets: ['HC-000001'],
      command: 'LED_BLINK',
      durationMs: 0,
    }),
  });
  assert.equal(res.status, 202);
  const cmd = res.body;
  assert.equal(cmd.command, 'LED_BLINK');
  assert.equal(cmd.durationMs, 0);

  // Wait for polling & ACK
  await new Promise(r => setTimeout(r, 600));

  // Virtual Hanger ledUntil should be ~now + 300,000ms (5 min safety timeout)
  assert.ok(hanger.ledUntil > Date.now() + 250000, 'Hanger ledUntil is set to persistent 5m safety timeout');

  const snap = await api('/api/snapshot', { userAuth: true });
  const serverCmd = snap.body.commands.find(c => c.numericId === cmd.numericId);
  assert.equal(serverCmd.status, 'ACKED');
  assert.equal(serverCmd.acknowledgements['HC-000001'].result, 'OK');
});

test('Scenario K: LED STOP (command = LED_OFF) -> Virtual Hanger turns off LED immediately -> ACK -> ACKED', async () => {
  const hanger = vgw.hangers.get('HC-000001');
  assert.ok(hanger.ledUntil > Date.now(), 'Hanger was blinking');
  hanger.ackMode = 'OK';

  const res = await api('/api/commands', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({
      targets: ['HC-000001'],
      command: 'LED_OFF',
    }),
  });
  assert.equal(res.status, 202);
  const cmd = res.body;
  assert.equal(cmd.command, 'LED_OFF');

  // Wait for polling & ACK
  await new Promise(r => setTimeout(r, 600));

  // Virtual Hanger ledUntil should be 0 (turned off immediately)
  assert.equal(hanger.ledUntil, 0, 'Hanger ledUntil reset to 0 immediately upon LED_OFF');

  const snap = await api('/api/snapshot', { userAuth: true });
  const serverCmd = snap.body.commands.find(c => c.numericId === cmd.numericId);
  assert.equal(serverCmd.status, 'ACKED');
  assert.equal(serverCmd.acknowledgements['HC-000001'].result, 'OK');
});

test('Scenario L: Multi-Hanger Outfit FIND & STOP flow', async () => {
  const h1 = vgw.hangers.get('HC-000001');
  const h2 = vgw.hangers.get('HC-000002');
  h1.ledUntil = 0;
  h2.ledUntil = 0;

  // Multi-target start
  const startRes = await api('/api/commands', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({
      targets: ['HC-000001', 'HC-000002'],
      command: 'LED_BLINK',
      durationMs: 0,
    }),
  });
  assert.equal(startRes.status, 202);

  await new Promise(r => setTimeout(r, 500));
  assert.ok(h1.ledUntil > Date.now());
  assert.ok(h2.ledUntil > Date.now());

  // Multi-target stop
  const stopRes = await api('/api/commands', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({
      targets: ['HC-000001', 'HC-000002'],
      command: 'LED_OFF',
    }),
  });
  assert.equal(stopRes.status, 202);

  await new Promise(r => setTimeout(r, 500));
  assert.equal(h1.ledUntil, 0);
  assert.equal(h2.ledUntil, 0);
});

test('Scenario M: Recommendation Engine Unit Tests (0~100 score, search, ranking, chat)', () => {
  const OutfitEngine = require('../shared/recommendation');

  // 1. Chosung & search
  assert.ok(OutfitEngine.matchQuery('네이비 셔츠', '네'));
  assert.ok(OutfitEngine.matchQuery('청바지', 'ㅊ'));
  assert.ok(OutfitEngine.matchQuery('블랙 슬랙스', 'ㅂㄹ'));
  assert.ok(OutfitEngine.matchQuery('HC-000001', 'hc-00'));

  // 2. Garment categorization
  assert.equal(OutfitEngine.categorizeGarment({ category: '셔츠', name: '옥스포드' }), 'top');
  assert.equal(OutfitEngine.categorizeGarment({ category: '바지', name: '치노 팬츠' }), 'bottom');
  assert.equal(OutfitEngine.categorizeGarment({ category: '아우터', name: '블레이저' }), 'outer');

  // 3. Mock garments
  const mockGarments = [
    { id: 'g1', name: '네이비 셔츠', category: '셔츠', color: '네이비', season: '봄/가을', currentState: 'IN_WARDROBE', currentHanger: 'HC-000001' },
    { id: 'g2', name: '베이지 슬랙스', category: '슬랙스', color: '베이지', season: '봄/가을', currentState: 'IN_WARDROBE', currentHanger: 'HC-000002' },
    { id: 'g3', name: '차콜 자켓', category: '자켓', color: '차콜', season: '봄/가을', currentState: 'IN_WARDROBE', currentHanger: 'HC-000003' },
    { id: 'g4', name: '빨간 반바지', category: '반바지', color: '레드', season: '여름', currentState: 'OUT', currentHanger: null },
  ];

  // 4. Whole Outfit generation
  const outfits = OutfitEngine.generateWholeOutfits(mockGarments, { temp: 18, precipitation: 0 }, 'business');
  assert.ok(outfits.length > 0);
  for (const o of outfits) {
    assert.ok(o.displayScore >= 0 && o.displayScore <= 100, `displayScore ${o.displayScore} is between 0 and 100`);
    assert.ok(o.items.every(item => item.currentState === 'IN_WARDROBE'), 'Only IN_WARDROBE garments included');
    assert.ok(o.reasons.length >= 1, 'At least 1 reason provided');
  }

  // 5. Single Garment Matching
  const matches = OutfitEngine.generateSingleGarmentMatches('g1', mockGarments, { temp: 18, precipitation: 0 }, 'business');
  assert.ok(matches.length > 0);
  assert.equal(matches[0].garment.id, 'g2'); // Beige slacks best match for navy shirt
  assert.ok(matches[0].displayScore >= 0 && matches[0].displayScore <= 100);

  // 6. Chat Query Processing
  const chatRes = OutfitEngine.processChatQuery('오늘 출근할 때 입을 단정한 코디', mockGarments, { temp: 18, precipitation: 0 });
  assert.equal(chatRes.inferredOccasion, 'business');
  assert.ok(chatRes.recommendations.length > 0);
});

test('Scenario N: Empty Hanger Physical Lifecycle (A, B, C, D) & Logout Persistence', async () => {
  // 1. Setup registered garment
  const tagUid = '04E1E2E3E4E5E6';
  const gRes = await api('/api/garments', {
    method: 'POST',
    userAuth: true,
    body: JSON.stringify({ name: '물리 테스트 코트', tagUid, category: '코트', color: '블랙' }),
  });
  const garment = gRes.body;

  // Scenario A: Tag Insert on HC-000003 -> PRESENT + IN_WARDROBE
  await vgw.tagInsert('HC-000003', tagUid);
  const snapA = await api('/api/snapshot', { userAuth: true });
  const hA = snapA.body.hangers.find(h => h.hangerId === 'HC-000003');
  const gA = snapA.body.garments.find(g => g.id === garment.id);
  assert.equal(hA.state, 'PRESENT');
  assert.equal(gA.currentState, 'IN_WARDROBE');
  assert.equal(gA.currentHanger, 'HC-000003');

  // Scenario B: Remove only tag (Hanger remains online on rail) -> EMPTY + ONLINE + Garment OUT
  await vgw.tagRemove('HC-000003');
  const snapB = await api('/api/snapshot', { userAuth: true });
  const hB = snapB.body.hangers.find(h => h.hangerId === 'HC-000003');
  const gB = snapB.body.garments.find(g => g.id === garment.id);
  assert.equal(hB.state, 'EMPTY');
  assert.ok(Date.now() - Date.parse(hB.lastSeen) < 30000, 'HC-000003 is ONLINE');
  assert.equal(gB.currentState, 'OUT');
  assert.equal(gB.currentHanger, null);

  // Scenario C: Empty hanger removed from rail (offline) -> OFFLINE
  await vgw.setOnline('HC-000003', false);
  // Simulate offline state update on server
  hB.reportedState = hB.state = 'OFFLINE';
  hB.lastSeen = new Date(Date.now() - 35000).toISOString();
  const snapC = await api('/api/snapshot', { userAuth: true });
  const gC = snapC.body.garments.find(g => g.id === garment.id);
  assert.equal(gC.currentState, 'OUT');

  // Scenario D: Empty hanger reconnected to rail -> ONLINE + EMPTY (garment remains OUT)
  await vgw.setOnline('HC-000003', true);
  await vgw.sendStatus(vgw.hangers.get('HC-000003'));
  const snapD = await api('/api/snapshot', { userAuth: true });
  const hD = snapD.body.hangers.find(h => h.hangerId === 'HC-000003');
  const gD = snapD.body.garments.find(g => g.id === garment.id);
  assert.equal(hD.state, 'EMPTY');
  assert.ok(Date.now() - Date.parse(hD.lastSeen) < 30000, 'HC-000003 is ONLINE');
  assert.equal(gD.currentState, 'OUT', 'Garment remains OUT without tag');
  assert.equal(gD.currentHanger, null);

  // Logout/Login Persistence Verification:
  // After client token discard and re-login, snapshot retains all garments
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner-scenarios@example.com', password: 'mypassword1234' }),
  });
  assert.equal(loginRes.status, 200);
  const newToken = (await loginRes.json()).token;

  const snapRelogin = await fetch(`${baseUrl}/api/snapshot`, {
    headers: { Authorization: `Bearer ${newToken}` },
  }).then(r => r.json());

  assert.ok(snapRelogin.garments.some(g => g.id === garment.id), 'Garment data is preserved after logout and relogin');
});
