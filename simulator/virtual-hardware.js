'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');

class VirtualHanger {
  constructor(hangerId, initialUid = null) {
    this.hangerId = hangerId.toUpperCase();
    this.state = initialUid ? 'PRESENT' : 'EMPTY';
    this.tagUid = initialUid ? initialUid.replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
    this.sequence = 0;
    this.bootId = Math.floor(Math.random() * 0xffffffff).toString(16);
    this.isOnline = true;
    this.ackMode = 'OK'; // 'OK' | 'ERROR' | 'IGNORE'
    this.lastCommand = null;
    this.ledUntil = 0;
    this.channel = 6;
    this.rssi = -45;
  }

  createStatusPayload(overrideSeq = null, overrideBoot = null) {
    const seq = overrideSeq !== null ? overrideSeq : ++this.sequence;
    const boot = overrideBoot !== null ? overrideBoot : this.bootId;
    return {
      hangerId: this.hangerId,
      state: this.state,
      tagUid: this.tagUid,
      sequence: seq,
      bootId: boot,
      channel: this.channel,
      rssi: this.rssi + Math.floor(Math.random() * 6 - 3),
      firmwareVersion: '1.0.0',
      gatewayFirmwareVersion: '1.0.0',
      errorFlags: 0,
    };
  }
}

class VirtualGateway {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.BASE_URL || 'http://localhost:8787';
    this.deviceToken = options.deviceToken || process.env.DEVICE_TOKEN || 'development-device-token';
    this.gatewayId = options.gatewayId || 'GW-SIM001';
    this.pollIntervalMs = options.pollIntervalMs || 1000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
    this.silent = options.silent || false;

    this.hangers = new Map();
    this.handledCommands = new Set();
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.isRunning = false;

    // Initialize 5 default virtual hangers (HC-000001 ~ HC-000005) in fresh EMPTY state
    for (let i = 1; i <= 5; i++) {
      const id = `HC-${i.toString(16).padStart(6, '0').toUpperCase()}`;
      this.hangers.set(id, new VirtualHanger(id));
    }
  }

  log(...args) {
    if (!this.silent) {
      console.log('[VirtualHW]', ...args);
    }
  }

  async sendStatus(hanger, overrideSeq = null, overrideBoot = null) {
    const payload = hanger.createStatusPayload(overrideSeq, overrideBoot);
    payload.gatewayId = this.gatewayId;

    const res = await fetch(`${this.baseUrl}/api/gateway/status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.deviceToken}`,
        'Content-Type': 'application/json',
        'X-Gateway-Id': this.gatewayId,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async pollCommands() {
    try {
      const res = await fetch(`${this.baseUrl}/api/gateway/commands`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.deviceToken}`,
          'X-Gateway-Id': this.gatewayId,
        },
      });

      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const commands = data.commands || [];

      for (const cmd of commands) {
        if (this.handledCommands.has(cmd.numericId)) continue;
        this.handledCommands.add(cmd.numericId);
        this.handleCommand(cmd);
      }
    } catch (err) {
      this.log('Poll commands error:', err.message);
    }
  }

  async handleCommand(cmd) {
    const targets = cmd.targets || [];
    const commandId = cmd.numericId;
    const commandType = cmd.command || 'LED_BLINK';
    const durationMs = cmd.durationMs !== undefined ? Number(cmd.durationMs) : 0;
    const SAFETY_TIMEOUT_MS = 300000; // 5분 기본 안전 타임아웃

    for (const targetId of targets) {
      const hanger = this.hangers.get(targetId.toUpperCase());
      if (!hanger) continue;

      if (commandType === 'LED_OFF') {
        hanger.ledUntil = 0;
        this.log(`[LED OFF] ${hanger.hangerId} commandId=${commandId} (ACK mode: ${hanger.ackMode})`);
      } else {
        // LED_BLINK: durationMs > 0 -> 지정 시간, durationMs == 0 -> 5분 Safety Timeout 지속 점멸
        const effectiveDuration = durationMs > 0 ? durationMs : SAFETY_TIMEOUT_MS;
        hanger.ledUntil = Date.now() + effectiveDuration;
        this.log(`[LED BLINK] ${hanger.hangerId} commandId=${commandId} duration=${durationMs > 0 ? durationMs + 'ms' : 'PERSISTENT (5m safety)'} (ACK mode: ${hanger.ackMode})`);
      }
      hanger.lastCommand = cmd;

      if (hanger.ackMode === 'OK') {
        setTimeout(() => this.sendAck(commandId, hanger.hangerId, 'OK', 0), 50);
      } else if (hanger.ackMode === 'ERROR') {
        setTimeout(() => this.sendAck(commandId, hanger.hangerId, 'ERROR', 1), 50);
      } else if (hanger.ackMode === 'IGNORE') {
        this.log(`[ACK IGNORED] ${hanger.hangerId} ignoring ACK for commandId=${commandId}`);
      }
    }
  }

  async sendAck(commandId, hangerId, result = 'OK', errorCode = 0) {
    try {
      const res = await fetch(`${this.baseUrl}/api/gateway/ack`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.deviceToken}`,
          'Content-Type': 'application/json',
          'X-Gateway-Id': this.gatewayId,
        },
        body: JSON.stringify({
          commandId,
          hangerId,
          result,
          errorCode,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        this.log(`[ACK SENT] commandId=${commandId} hangerId=${hangerId} status=${data.status}`);
      } else {
        this.log(`[ACK FAIL] commandId=${commandId} hangerId=${hangerId} error=${data.error}`);
      }
      return data;
    } catch (err) {
      this.log(`[ACK ERROR] ${err.message}`);
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log(`Starting Virtual Gateway connected to ${this.baseUrl}`);

    // Initial status broadcast for all online hangers (default fresh EMPTY)
    for (const hanger of this.hangers.values()) {
      if (hanger.isOnline) {
        try {
          await this.sendStatus(hanger);
        } catch (e) {
          this.log(`Initial status send failed for ${hanger.hangerId}:`, e.message);
        }
      }
    }

    // Polling loop for commands
    this.pollTimer = setInterval(() => this.pollCommands(), this.pollIntervalMs);

    // Heartbeat loop for online hangers
    this.heartbeatTimer = setInterval(async () => {
      for (const hanger of this.hangers.values()) {
        if (hanger.isOnline) {
          try {
            await this.sendStatus(hanger);
          } catch (_) {}
        }
      }
    }, this.heartbeatIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.log('Virtual Gateway stopped.');
  }

  reset() {
    for (const h of this.hangers.values()) {
      h.state = 'EMPTY';
      h.tagUid = null;
      h.ackMode = 'OK';
      h.isOnline = true;
      h.sequence = 0;
      h.ledUntil = 0;
      h.lastCommand = null;
    }
  }

  // Interactive Operations
  async tagInsert(hangerId, uid) {
    const hanger = this.hangers.get(hangerId.toUpperCase());
    if (!hanger) throw new Error(`Hanger not found: ${hangerId}`);
    hanger.state = 'PRESENT';
    hanger.tagUid = String(uid).replace(/[^0-9a-f]/gi, '').toUpperCase();
    return this.sendStatus(hanger);
  }

  async tagRemove(hangerId) {
    const hanger = this.hangers.get(hangerId.toUpperCase());
    if (!hanger) throw new Error(`Hanger not found: ${hangerId}`);
    hanger.state = 'EMPTY';
    hanger.tagUid = null;
    return this.sendStatus(hanger);
  }

  async tagChange(hangerId, newUid) {
    return this.tagInsert(hangerId, newUid);
  }

  async setOnline(hangerId, online = true) {
    const hanger = this.hangers.get(hangerId.toUpperCase());
    if (!hanger) throw new Error(`Hanger not found: ${hangerId}`);
    hanger.isOnline = !!online;
    if (hanger.isOnline) {
      return this.sendStatus(hanger);
    }
  }

  setAckMode(hangerId, mode) {
    const hanger = this.hangers.get(hangerId.toUpperCase());
    if (!hanger) throw new Error(`Hanger not found: ${hangerId}`);
    if (!['OK', 'ERROR', 'IGNORE'].includes(mode)) throw new Error(`Invalid ack mode: ${mode}`);
    hanger.ackMode = mode;
  }

  async sendDuplicate(hangerId) {
    const hanger = this.hangers.get(hangerId.toUpperCase());
    if (!hanger) throw new Error(`Hanger not found: ${hangerId}`);
    return this.sendStatus(hanger, hanger.sequence, hanger.bootId);
  }

  getStatusSummary() {
    const list = [];
    for (const h of this.hangers.values()) {
      const ledActive = Date.now() < (h.ledUntil || 0);
      list.push({
        hangerId: h.hangerId,
        state: h.state,
        tagUid: h.tagUid || '(none)',
        seq: h.sequence,
        bootId: h.bootId,
        online: h.isOnline ? 'ONLINE' : 'STOPPED(will timeout)',
        isOnline: h.isOnline,
        ackMode: h.ackMode,
        ledActive,
        ledUntil: h.ledUntil || 0,
        lastCommandId: h.lastCommand?.numericId || null,
      });
    }
    return list;
  }
}

// CLI Interactive Runner
if (require.main === module) {
  const vgw = new VirtualGateway();
  vgw.start().then(() => {
    console.log('\n=== PA Virtual Hardware Interactive CLI ===');
    console.log('Available commands:');
    console.log('  tag-insert <hangerId> <uid>  - 의류 NFC 태그 거치 (예: tag-insert HC-000001 04A1B2C3D4E5F6)');
    console.log('  tag-remove <hangerId>        - 의류 NFC 태그 분리 (예: tag-remove HC-000001)');
    console.log('  tag-change <hangerId> <uid>  - 다른 의류 태그로 교체');
    console.log('  online <hangerId>            - 하트비트 전송 활성화');
    console.log('  offline <hangerId>           - 하트비트 중단 (서버 OFFLINE 타임아웃 유도)');
    console.log('  ack-ok <hangerId>            - 정상 ACK 응답 모드 (기본)');
    console.log('  ack-error <hangerId>         - 에러 ACK 응답 모드');
    console.log('  ack-ignore <hangerId>        - ACK 무시 모드 (서버 TIMEOUT 유도)');
    console.log('  duplicate <hangerId>         - 동일 패킷 중복 재전송');
    console.log('  status                       - 현재 가상 옷걸이 상태 보기');
    console.log('  exit                         - 종료\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'PA-VirtualHW> ',
    });

    rl.prompt();

    rl.on('line', async (line) => {
      const parts = line.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const hId = parts[1]?.toUpperCase();
      const arg = parts[2];

      try {
        switch (cmd) {
          case 'tag-insert':
            if (!hId || !arg) console.log('사용법: tag-insert <hangerId> <uid>');
            else {
              await vgw.tagInsert(hId, arg);
              console.log(`[OK] ${hId} 에 태그 ${arg} 거치 완료.`);
            }
            break;
          case 'tag-remove':
            if (!hId) console.log('사용법: tag-remove <hangerId>');
            else {
              await vgw.tagRemove(hId);
              console.log(`[OK] ${hId} 태그 분리 완료 (EMPTY).`);
            }
            break;
          case 'tag-change':
            if (!hId || !arg) console.log('사용법: tag-change <hangerId> <uid>');
            else {
              await vgw.tagChange(hId, arg);
              console.log(`[OK] ${hId} 에 새 태그 ${arg} 교체 완료.`);
            }
            break;
          case 'online':
            if (!hId) console.log('사용법: online <hangerId>');
            else {
              await vgw.setOnline(hId, true);
              console.log(`[OK] ${hId} 하트비트 활성화.`);
            }
            break;
          case 'offline':
            if (!hId) console.log('사용법: offline <hangerId>');
            else {
              await vgw.setOnline(hId, false);
              console.log(`[OK] ${hId} 하트비트 중단 (서버 OFFLINE 대기).`);
            }
            break;
          case 'ack-ok':
            if (!hId) console.log('사용법: ack-ok <hangerId>');
            else {
              vgw.setAckMode(hId, 'OK');
              console.log(`[OK] ${hId} ACK 모드: OK 설정.`);
            }
            break;
          case 'ack-error':
            if (!hId) console.log('사용법: ack-error <hangerId>');
            else {
              vgw.setAckMode(hId, 'ERROR');
              console.log(`[OK] ${hId} ACK 모드: ERROR 설정.`);
            }
            break;
          case 'ack-ignore':
            if (!hId) console.log('사용법: ack-ignore <hangerId>');
            else {
              vgw.setAckMode(hId, 'IGNORE');
              console.log(`[OK] ${hId} ACK 모드: IGNORE 설정 (서버 TIMEOUT 유도).`);
            }
            break;
          case 'duplicate':
            if (!hId) console.log('사용법: duplicate <hangerId>');
            else {
              const res = await vgw.sendDuplicate(hId);
              console.log(`[OK] ${hId} 중복 패킷 전송 (서버 응답 duplicate=${res.duplicate}).`);
            }
            break;
          case 'status':
            console.table(vgw.getStatusSummary());
            break;
          case 'exit':
          case 'quit':
            vgw.stop();
            process.exit(0);
            break;
          default:
            if (cmd) console.log(`알 수 없는 명령어: ${cmd}`);
            break;
        }
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
      }
      rl.prompt();
    });
  });
}

module.exports = { VirtualGateway, VirtualHanger };
