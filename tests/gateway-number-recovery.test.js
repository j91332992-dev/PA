'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('startup repairs duplicate gateway numbers before persistent storage saves', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-gateway-number-recovery-'));
  const dataPath = path.join(tempDir, 'wardrobe.json');
  fs.writeFileSync(dataPath, JSON.stringify({
    schemaVersion: 5,
    users: [],
    wardrobes: [{ id: 'wd-recovery', userId: 'missing-user', name: '복구 테스트', createdAt: '2026-01-01T00:00:00.000Z' }],
    gateways: [
      { gatewayId: 'GW-RECOVERY-1', wardrobeId: 'wd-recovery', gatewayNumber: 2, createdAt: '2026-01-01T00:00:00.000Z' },
      { gatewayId: 'GW-RECOVERY-2', wardrobeId: 'wd-recovery', gatewayNumber: 2, createdAt: '2026-01-02T00:00:00.000Z' },
    ],
    hangers: [], garments: [], events: [], commands: [],
  }));

  const child = spawn(process.execPath, ['backend/server-v3.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_PATH: dataPath, DATABASE_URL: '', DISABLE_BACKGROUND_TASKS: 'true' },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 3000;
    let recovered;
    while (Date.now() < deadline) {
      recovered = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      if (recovered.gateways.map(gateway => gateway.gatewayNumber).join(',') === '2,3') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(child.exitCode, null, 'duplicate gateway data must not crash startup');
    assert.deepEqual(recovered.gateways.map(gateway => gateway.gatewayNumber), [2, 3]);
  } finally {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
