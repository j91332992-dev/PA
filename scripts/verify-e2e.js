'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');
const { VirtualGateway } = require('../simulator/virtual-hardware');

async function run() {
  console.log('=== Step 1: Starting Real Backend Server (Port 8999) ===');
  const serverProc = spawn('node', ['backend/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '8999', DATA_PATH: 'data/test-e2e.json', SIMULATION_ENABLED: 'true' },
    stdio: 'inherit'
  });

  await new Promise(resolve => setTimeout(resolve, 1000));
  const baseUrl = 'http://localhost:8999';

  try {
    console.log('\n=== Step 2: Initialize Virtual Gateway (5 Hangers) ===');
    const vgw = new VirtualGateway({
      baseUrl,
      deviceToken: 'development-device-token',
      pollIntervalMs: 200,
      heartbeatIntervalMs: 3000,
      silent: false
    });
    await vgw.start();

    console.log('\n=== Step 3: User Signup & Login ===');
    const signupRes = await fetch(baseUrl + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'manual-test@example.com', password: 'testpassword1234', name: '수동검증관' })
    });
    const signupData = await signupRes.json();
    console.log('[HTTP] Signup status:', signupRes.status, 'User:', signupData.user?.email);
    const token = signupData.token;

    console.log('\n=== Step 3b: Claim Virtual Gateway and its Hangers ===');
    const claimHeaders = { 'content-type': 'application/json', 'authorization': 'Bearer ' + token };
    const intentRes = await fetch(baseUrl + '/api/gateways/GW-SIM001/claim-intent', { method: 'POST', headers: claimHeaders });
    const intent = await intentRes.json();
    if (!intentRes.ok || !intent.claimToken) throw new Error(`Gateway claim intent failed: ${intentRes.status} ${JSON.stringify(intent)}`);
    const claimRes = await fetch(baseUrl + '/api/gateways/GW-SIM001/claim', {
      method: 'POST',
      headers: claimHeaders,
      body: JSON.stringify({ claimToken: intent.claimToken })
    });
    if (!claimRes.ok) throw new Error(`Gateway claim failed: ${claimRes.status} ${await claimRes.text()}`);
    console.log('[HTTP] Gateway claimed:', (await claimRes.json()).gatewayId);
    const hangerIntentRes = await fetch(baseUrl + '/api/hangers/HC-000001/claim-intent', { method: 'POST', headers: claimHeaders });
    const hangerIntent = await hangerIntentRes.json();
    if (!hangerIntentRes.ok || !hangerIntent.claimToken) throw new Error(`Hanger claim intent failed: ${hangerIntentRes.status} ${JSON.stringify(hangerIntent)}`);
    const hangerClaimRes = await fetch(baseUrl + '/api/hangers/HC-000001/claim', { method: 'POST', headers: claimHeaders, body: JSON.stringify({ claimToken: hangerIntent.claimToken }) });
    if (!hangerClaimRes.ok) throw new Error(`Hanger claim failed: ${hangerClaimRes.status} ${await hangerClaimRes.text()}`);
    console.log('[HTTP] Hanger claimed: HC-000001');

    console.log('\n=== Step 4: Connect Real WebSocket Client ===');
    const ws = new WebSocket('ws://localhost:8999/ws', [`wardrobe-token.${token}`]);
    const wsEvents = [];
    ws.on('message', d => {
      const parsed = JSON.parse(d.toString());
      console.log('[WS RECV EVENT]', parsed.type, parsed.payload?.hangerId || parsed.payload?.name || parsed.payload?.id || '');
      wsEvents.push(parsed);
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    console.log('\n=== Step 5: Register Garment (tagUid: 04A1B2C3D4E5F6) ===');
    const gRes = await fetch(baseUrl + '/api/garments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: '수동 검증 블레이저', tagUid: '04A1B2C3D4E5F6', category: '자켓' })
    });
    const garment = await gRes.json();
    console.log('[HTTP] Garment registered:', garment.name, 'currentState:', garment.currentState);

    console.log('\n=== Step 6: Virtual Tag Insert on HC-000001 ===');
    await vgw.tagInsert('HC-000001', '04A1B2C3D4E5F6');
    await new Promise(resolve => setTimeout(resolve, 300));

    const snap1 = await (await fetch(baseUrl + '/api/snapshot', { headers: { 'authorization': 'Bearer ' + token } })).json();
    const h1 = snap1.hangers.find(x => x.hangerId === 'HC-000001');
    const g1 = snap1.garments.find(x => x.id === garment.id);
    console.log('[SNAPSHOT 1] Hanger state:', h1.state, 'Garment state:', g1.currentState, 'currentHanger:', g1.currentHanger);

    console.log('\n=== Step 7: Request FIND for Garment ===');
    const findRes = await fetch(baseUrl + '/api/garments/' + garment.id + '/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: '{}'
    });
    const cmd1 = await findRes.json();
    console.log('[HTTP] FIND requested, commandId:', cmd1.numericId, 'status:', cmd1.status, 'targets:', cmd1.targets);

    console.log('\n=== Step 8: Await Virtual Hardware Poll -> LED ON -> ACK OK ===');
    await new Promise(resolve => setTimeout(resolve, 600));

    const snap2 = await (await fetch(baseUrl + '/api/snapshot', { headers: { 'authorization': 'Bearer ' + token } })).json();
    const cmdAcked = snap2.commands.find(c => c.id === cmd1.id);
    console.log('[SNAPSHOT 2] Command status after ACK:', cmdAcked.status, 'ack result:', cmdAcked.acknowledgements['HC-000001']?.result);

    console.log('\n=== Step 9: Test Real 15-second Production TIMEOUT with ACK IGNORE ===');
    vgw.setAckMode('HC-000001', 'IGNORE');
    const findRes2 = await fetch(baseUrl + '/api/garments/' + garment.id + '/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: '{}'
    });
    const cmd2 = await findRes2.json();
    console.log('[HTTP] FIND #2 (ACK IGNORE mode) requested, commandId:', cmd2.numericId, 'status:', cmd2.status);

    console.log('[TIMER] Waiting 16.5 seconds for real production 15s timeout to trigger...');
    const startTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 16500));
    console.log('[TIMER] 16.5 seconds elapsed. Actual:', ((Date.now() - startTime) / 1000).toFixed(1), 's');

    const snap3 = await (await fetch(baseUrl + '/api/snapshot', { headers: { 'authorization': 'Bearer ' + token } })).json();
    const cmdTimedOut = snap3.commands.find(c => c.id === cmd2.id);
    console.log('[SNAPSHOT 3] Command #2 status after 16.5s:', cmdTimedOut.status, '(expiresAt was:', cmdTimedOut.expiresAt, ')');

    console.log('\n=== Step 10: Summary of Received WebSocket Events ===');
    console.log(wsEvents.map(e => ({ type: e.type, at: e.at })));

    vgw.stop();
    ws.close();
  } finally {
    serverProc.kill();
    try {
      const fs = require('fs');
      if (fs.existsSync('data/test-e2e.json')) fs.unlinkSync('data/test-e2e.json');
      if (fs.existsSync('data/test-e2e.json.bak')) fs.unlinkSync('data/test-e2e.json.bak');
    } catch (_) {}
  }
}

run().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
