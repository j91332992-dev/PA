#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <SPI.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Adafruit_PN532.h>
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif
#include "protocol.h"

// PN532 was proven with the NTAG213 over this hardware SPI connection.
constexpr uint8_t PIN_SCK = D8;
constexpr uint8_t PIN_MISO = D9;
constexpr uint8_t PIN_MOSI = D10;
constexpr uint8_t PIN_NFC_SS = D6;
constexpr uint8_t PIN_LED = D1;
constexpr uint32_t LED_SAFETY_TIMEOUT_MS = sw::LED_SAFETY_TIMEOUT_MS;

Preferences prefs;
Adafruit_PN532 nfc(PIN_NFC_SS, &SPI);
String hanger;
String pairedGateway;
String discoveredGateway;
String displayName;
bool hangerLinkDisabled = false;
volatile bool reportAfterGatewayBeacon = false;
uint32_t sequence = 0, bootId = 0, lastHeartbeat = 0, lastScan = 0, lastBeacon = 0, ledUntil = 0;
uint8_t channel = 1;
BLECharacteristic* bleStatusCharacteristic = nullptr;
bool bleActive = false;

constexpr char HANGER_BLE_SERVICE_UUID[] = "a4e66a20-0fb0-4dce-8be0-18cf7bc82001";
constexpr char HANGER_BLE_CONFIG_UUID[] = "a4e66a21-0fb0-4dce-8be0-18cf7bc82001";
constexpr char HANGER_BLE_STATUS_UUID[] = "a4e66a22-0fb0-4dce-8be0-18cf7bc82001";

// Grace-period state machine variables
uint32_t lastSeenMs = 0;
uint8_t currentUid[7] = {0};
uint8_t currentLen = 0;
uint8_t candidateUid[7] = {0};
uint8_t candidateLen = 0;
uint8_t candidateHits = 0;
uint32_t lastNfcInitAttemptMs = 0;
uint32_t lastNfcHealthCheckMs = 0;
uint32_t lastRawUidLogMs = 0;

// If the PN532 is still booting after a power reconnect, retry quickly rather
// than leaving the hanger unavailable for multiple seconds.
constexpr uint32_t PN532_REINIT_COOLDOWN_MS = 500;
constexpr uint32_t NO_RESPONSE_REMOVE_MS = 800;
constexpr uint16_t PN532_SCAN_TIMEOUT_MS = 120;
constexpr uint32_t PN532_HEALTH_CHECK_MS = 1000;
// A hanger can reboot while the rod remains on another Wi-Fi channel. Do not
// leave it isolated for the old 60-second recovery window.
constexpr uint32_t GATEWAY_LOSS_RECOVERY_MS = 3500;
constexpr uint32_t CHANNEL_RECOVERY_DWELL_MS = 500;

sw::State state = sw::State::EMPTY;
bool nfcReady = false;

String currentUidHex() {
  String value;
  for (uint8_t i = 0; i < currentLen; ++i) {
    char byteHex[3];
    snprintf(byteHex, sizeof byteHex, "%02X", currentUid[i]);
    value += byteHex;
  }
  return value;
}

void setHangerBleStatus(const char* stateName, const char* message) {
  if (!bleStatusCharacteristic) return;
  String payload = "{\"state\":\"" + String(stateName) + "\",\"message\":\"" + String(message) +
      "\",\"hangerId\":\"" + hanger + "\",\"gatewayId\":\"" + pairedGateway +
      "\",\"discoveredGatewayId\":\"" + discoveredGateway + "\",\"tagUid\":\"" + currentUidHex() +
      "\",\"tagPresent\":" + (state == sw::State::PRESENT ? "true" : "false") +
      ",\"nfcReady\":" + (nfcReady ? "true" : "false") + "}";
  bleStatusCharacteristic->setValue(payload.c_str());
  bleStatusCharacteristic->notify();
}

// The browser only sends a short, known BLE setup object. Keeping this small
// parser avoids adding a JSON dependency to the battery-powered hanger build.
String bleJsonText(const String& request, const char* key) {
  const String marker = "\"" + String(key) + "\":\"";
  int start = request.indexOf(marker);
  if (start < 0) return "";
  start += marker.length();
  String value;
  bool escaped = false;
  for (int i = start; i < request.length(); ++i) {
    const char c = request[i];
    if (escaped) {
      value += c;
      escaped = false;
    } else if (c == '\\') {
      escaped = true;
    } else if (c == '"') {
      return value;
    } else {
      value += c;
    }
  }
  return "";
}

void report(bool event);

class HangerBleConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String request = characteristic->getValue();
    const String action = bleJsonText(request, "action");
    if (action == "pair") {
      if (!discoveredGateway.length()) {
        setHangerBleStatus("waiting_gateway", "옷봉 신호를 찾는 중입니다. 옷봉 전원과 거리를 확인하세요.");
        return;
      }
      pairedGateway = discoveredGateway;
      hangerLinkDisabled = false;
      prefs.putString("gateway", pairedGateway);
      const String requestedName = bleJsonText(request, "displayName");
      if (requestedName.length()) prefs.putString("displayName", requestedName);
      prefs.putBool("linkDisabled", false);
      setHangerBleStatus("paired", "옷봉과 연결했습니다. 이제 옷 태그 상태를 확인할 수 있습니다.");
      report(true);
      return;
    }
    if (action == "forget") {
      pairedGateway = "";
      hangerLinkDisabled = true;
      prefs.remove("gateway");
      prefs.putBool("linkDisabled", true);
      setHangerBleStatus("unpaired", "옷봉 연결을 제거했습니다. 다시 연결하려면 옷걸이 찾기를 누르세요.");
      return;
    }
    if (action == "status") {
      setHangerBleStatus(hangerLinkDisabled ? "unpaired" : "ready", "옷걸이 상태를 불러왔습니다.");
      return;
    }
    setHangerBleStatus("error", "요청을 이해하지 못했습니다.");
  }
};

class HangerBleServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer*) override {
    BLEDevice::startAdvertising();
    Serial.println("[BLE] Advertising restarted");
  }
};

void startHangerBle() {
  if (bleActive) return;
  BLEDevice::init(displayName.c_str());
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new HangerBleServerCallbacks());
  BLEService* service = server->createService(HANGER_BLE_SERVICE_UUID);
  BLECharacteristic* config = service->createCharacteristic(HANGER_BLE_CONFIG_UUID, BLECharacteristic::PROPERTY_WRITE);
  config->setCallbacks(new HangerBleConfigCallbacks());
  bleStatusCharacteristic = service->createCharacteristic(
      HANGER_BLE_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(HANGER_BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  bleActive = true;
  setHangerBleStatus(hangerLinkDisabled ? "unpaired" : "ready", "블루투스로 옷걸이 연결과 옷 태그 상태를 확인하세요.");
  Serial.printf("[BLE] Ready: %s\n", displayName.c_str());
}

void led(bool on) {
  digitalWrite(PIN_LED, LED_ACTIVE_HIGH ? (on ? HIGH : LOW) : (on ? LOW : HIGH));
#ifdef LED_BUILTIN
  digitalWrite(LED_BUILTIN, on ? LOW : HIGH);
#endif
}

void setChannel(uint8_t ch) {
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  channel = ch;
}

void addBroadcast() {
  esp_now_peer_info_t p{};
  memcpy(p.peer_addr, sw::BROADCAST, 6);
  p.channel = 0;
  p.ifidx = WIFI_IF_STA;
  p.encrypt = false;
  if (!esp_now_is_peer_exist(sw::BROADCAST)) esp_now_add_peer(&p);
}

void fill(sw::Packet& p, sw::Type type) {
  p.type = type;
  strlcpy(p.hangerId, hanger.c_str(), sizeof p.hangerId);
  p.state = state;
  p.uidLength = currentLen;
  memcpy(p.uid, currentUid, currentLen);
  p.sequence = ++sequence;
  p.bootId = bootId;
  p.errorFlags = nfcReady ? 0 : 1;
  strlcpy(p.firmware, "1.0.0", sizeof p.firmware);
}

bool send(sw::Packet& p) {
  if (hangerLinkDisabled) return false;
  sw::seal(p);
  return esp_now_send(sw::BROADCAST, reinterpret_cast<uint8_t*>(&p), sizeof p) == ESP_OK;
}

void report(bool event) {
  sw::Packet p;
  fill(p, event ? sw::Type::EVENT : sw::Type::STATUS);
  for (uint8_t i = 0; i < (event ? 2 : 1); i++) {
    send(p);
    if (event && i == 0) delay(5);
  }
  char uHex[16] = "";
  for (uint8_t i = 0; i < currentLen; i++) snprintf(uHex + i * 2, 3, "%02X", currentUid[i]);
  Serial.printf("[ESPNOW] %s state=%u uid=%s len=%u seq=%lu ch=%u\n", event ? "EVENT" : "HEARTBEAT", unsigned(state), uHex, currentLen, sequence, channel);
}

void transition(sw::State s) {
  if (s == state) return;
  state = s;
  char uHex[16] = "";
  for (uint8_t i = 0; i < currentLen; i++) snprintf(uHex + i * 2, 3, "%02X", currentUid[i]);
  Serial.printf("\n⚡ [STATE-CHANGE] state=%u (UID=%s len=%u)\n", unsigned(state), uHex, currentLen);
  setHangerBleStatus(state == sw::State::PRESENT ? "tag_present" : "tag_empty",
                     state == sw::State::PRESENT ? "옷 태그를 인식했습니다." : "현재 인식된 옷 태그가 없습니다.");
  report(true);
}

void ack(const sw::Packet& cmd) {
  sw::Packet a;
  fill(a, sw::Type::ACK);
  strlcpy(a.gatewayId, cmd.gatewayId, sizeof a.gatewayId);
  a.commandId = cmd.commandId;
  send(a);
  Serial.printf("[ACK-TX] %lu\n", cmd.commandId);
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
void receive(const esp_now_recv_info_t*, const uint8_t* data, int len) {
#else
void receive(const uint8_t*, const uint8_t* data, int len) {
#endif
  if (len != sizeof(sw::Packet)) return;
  sw::Packet p;
  memcpy(&p, data, sizeof p);
  if (!sw::valid(p)) return;
  if (p.type == sw::Type::BEACON) {
    discoveredGateway = p.gatewayId;
    if (hangerLinkDisabled || (pairedGateway.length() && pairedGateway != discoveredGateway)) return;
    const uint32_t now = millis();
    // When the gateway reboots/rejoins, it has no current hanger state yet.
    // Push one status packet as soon as its beacon is heard instead of waiting
    // for the next 5~8 second heartbeat.
    const bool wasConnected = now - lastBeacon < 3500;
    lastBeacon = now;
    uint8_t gwCh = (uint8_t)p.errorFlags;
    if (gwCh >= 1 && gwCh <= 13 && channel != gwCh) {
      channel = gwCh;
      setChannel(channel);
      Serial.printf("[CHANNEL] locked to Gateway ch=%u\n", channel);
    }
    // Store the learned channel only when it changes; writing it on every
    // beacon would wear the flash unnecessarily.
    if (channel != prefs.getUChar("channel", 1)) prefs.putUChar("channel", channel);
    if (!wasConnected) reportAfterGatewayBeacon = true;
    if (!wasConnected) setHangerBleStatus("connected", "옷봉과 ESP-NOW로 연결되었습니다.");
    return;
  }
  if (p.type == sw::Type::COMMAND && !hangerLinkDisabled &&
      (!pairedGateway.length() || pairedGateway == String(p.gatewayId)) && sw::target(p, hanger.c_str())) {
    Serial.printf("[COMMAND] %lu cmd=%u\n", p.commandId, (unsigned)p.command);
    if (p.command == sw::Command::LED_OFF) {
      ledUntil = 0;
    } else if (p.command == sw::Command::LED_BLINK) {
      ledUntil = p.durationMs == 0 ? (millis() + LED_SAFETY_TIMEOUT_MS) : (millis() + p.durationMs);
    }
    ack(p);
  }
}

bool same(const uint8_t* a, uint8_t al, const uint8_t* b, uint8_t bl) {
  return al == bl && al > 0 && memcmp(a, b, al) == 0;
}

void logUid(const char* prefix, const uint8_t* uid, uint8_t uidLen) {
  Serial.print(prefix);
  for (uint8_t i = 0; i < uidLen; ++i) Serial.printf("%02X", uid[i]);
  Serial.printf(" len=%u\n", uidLen);
}

bool tryInitNfc() {
  lastNfcInitAttemptMs = millis();
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_NFC_SS);
  nfc.begin();
  uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    Serial.println("[NFC] INIT FAIL: GetFirmwareVersion");
    return false;
  }
  if (!nfc.SAMConfig() || !nfc.setPassiveActivationRetries(0xFF)) {
    Serial.println("[NFC] INIT FAIL: SAM/RFConfiguration");
    return false;
  }
  nfcReady = true;
  Serial.printf("[NFC] READY! SPI version=%08lX retries=max\n", version);
  // The first PN532 attempt can happen before the module has fully powered
  // up. Notify an already-open BLE diagnostics screen when a later retry
  // succeeds, rather than leaving it at the stale "check needed" state.
  setHangerBleStatus("nfc_ready", "옷 태그 읽기 장치가 준비되었습니다. 옷 태그를 대보세요.");
  return true;
}

// A bounded SPI poll leaves time for ESP-NOW event handling between scans.
int scanCard(uint8_t* uid, uint8_t& uidLen) {
  if (!nfcReady) {
    if (millis() - lastNfcInitAttemptMs < PN532_REINIT_COOLDOWN_MS) return -1;
    if (!tryInitNfc()) return -1;
  }
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, PN532_SCAN_TIMEOUT_MS) && uidLen > 0 && uidLen <= 7) return 1;
  // A plain no-tag response and a PN532 power loss look identical to the
  // normal poll API. Periodically probe the chip itself so a loose/pogo power
  // contact recovers automatically without requiring a C6 reset.
  if (millis() - lastNfcHealthCheckMs >= PN532_HEALTH_CHECK_MS) {
    lastNfcHealthCheckMs = millis();
    if (!nfc.getFirmwareVersion()) {
      nfcReady = false;
      Serial.println("[NFC] LINK LOST: PN532 power/connection changed; retrying init");
      setHangerBleStatus("nfc_reconnecting", "옷 태그 읽기 장치를 다시 연결하고 있습니다. 잠시 기다려 주세요.");
      return -1;
    }
  }
  return 0;
}

void scanNfc() {
  uint8_t u[7] = {0}, len = 0;
  int res = scanCard(u, len);
  uint32_t now = millis();

  if (res == 1) {
    // === TAG FOUND ===
    // Raw polling is useful during diagnosis, but emitting it on every
    // 100 ms scan can saturate USB Serial/JTAG when no monitor is attached.
    if (now - lastRawUidLogMs >= 1000) {
      lastRawUidLogMs = now;
      logUid("[NFC] RAW UID=", u, len);
    }
    if (state == sw::State::PRESENT) {
      if (same(u, len, currentUid, currentLen)) {
        lastSeenMs = now; // Keep alive (Zero flapping)
      } else {
        // Different tag placed while already in PRESENT
        if (same(u, len, candidateUid, candidateLen)) {
          if (++candidateHits >= PRESENT_CONFIRM_COUNT) {
            memcpy(currentUid, u, len);
            currentLen = len;
            lastSeenMs = now;
            candidateHits = 0;
            transition(sw::State::PRESENT);
          }
        } else {
          memcpy(candidateUid, u, len);
          candidateLen = len;
          candidateHits = 1;
          Serial.printf("[NFC] Candidate 1/%u\n", PRESENT_CONFIRM_COUNT);
        }
      }
    } else {
      // Current state is EMPTY
      if (same(u, len, candidateUid, candidateLen)) {
        if (++candidateHits >= PRESENT_CONFIRM_COUNT) {
          memcpy(currentUid, candidateUid, candidateLen);
          currentLen = candidateLen;
          lastSeenMs = now;
          candidateHits = 0;
          transition(sw::State::PRESENT);
        }
        } else {
          memcpy(candidateUid, u, len);
          candidateLen = len;
          candidateHits = 1;
          Serial.printf("[NFC] Candidate 1/%u\n", PRESENT_CONFIRM_COUNT);
        }
      }
  } else if (res == 0) {
    // === CLEAN NO TAG IN FIELD ===
    candidateHits = 0;
    if (state == sw::State::PRESENT) {
      if (now - lastSeenMs >= REMOVE_GRACE_MS) {
        memset(currentUid, 0, sizeof(currentUid));
        currentLen = 0;
        transition(sw::State::EMPTY);
      }
    }
  } else if (state == sw::State::PRESENT && now - lastSeenMs >= NO_RESPONSE_REMOVE_MS) {
    // A short PN532 timeout is treated as a glitch, but an extended period
    // with no successful card read is a real removal for UI purposes.
    memset(currentUid, 0, sizeof(currentUid));
    currentLen = 0;
    transition(sw::State::EMPTY);
  }
}

void recoverChannel() {
  if (millis() - lastBeacon < GATEWAY_LOSS_RECOVERY_MS) return;
  static uint32_t changed = 0;
  if (millis() - changed < CHANNEL_RECOVERY_DWELL_MS) return;
  changed = millis();
  channel = channel >= 13 ? 1 : channel + 1;
  setChannel(channel);
  Serial.printf("[CHANNEL] sweep %u\n", channel);
}

void setup() {
  Serial.begin(115200);
  // USB Serial/JTAG can block for seconds when a monitor is closed while
  // frequent NFC logs are being produced. Diagnostics must never stop tag
  // scanning, so drop unavailable log bytes instead of waiting for the host.
  Serial.setTxTimeoutMs(0);
  delay(500);
  pinMode(PIN_LED, OUTPUT);
#ifdef LED_BUILTIN
  pinMode(LED_BUILTIN, OUTPUT);
#endif
  led(false);
  uint64_t mac = ESP.getEfuseMac();
  char id[16];
  snprintf(id, sizeof id, "HC-%06llX", mac & 0xffffff);
  hanger = id;
  bootId = esp_random();
  prefs.begin("wardrobe", false);
  channel = prefs.getUChar("channel", 1);
  pairedGateway = prefs.getString("gateway", "");
  displayName = prefs.getString("displayName", "");
  if (!displayName.length()) displayName = "새 옷걸이";
  hangerLinkDisabled = prefs.getBool("linkDisabled", false);
  tryInitNfc();
  WiFi.mode(WIFI_STA);
  // ESP-NOW control frames and gateway beacons must not wait for modem sleep.
  WiFi.setSleep(false);
  WiFi.disconnect();
  setChannel(channel);
  if (esp_now_init() != ESP_OK) {
    Serial.println("[ERROR] ESP-NOW init");
    delay(2000);
    ESP.restart();
  }
  esp_now_register_recv_cb(receive);
  addBroadcast();
  startHangerBle();
  Serial.printf("[BOOT] %s channel=%u nfc=%s\n", hanger.c_str(), channel, nfcReady ? "READY" : "PENDING");
  report(true);
}

void loop() {
  uint32_t t = millis();
  bool isBlinking = (t < ledUntil) && ((t / 250) % 2 == 0);
  led(isBlinking);

  if (reportAfterGatewayBeacon) {
    reportAfterGatewayBeacon = false;
    Serial.println("[ESPNOW] Gateway rejoined: sending current state now");
    report(false);
  }

  // Keep the PN532 poll cadence bounded so ESP-NOW work can run between polls.
  if (t - lastScan >= NFC_SCAN_INTERVAL_MS + (bootId % 73)) {
    lastScan = t;
    scanNfc();
  }
  
  if (t - lastHeartbeat >= HEARTBEAT_MIN_MS + (bootId % HEARTBEAT_JITTER_MS)) {
    lastHeartbeat = t;
    report(false);
  }
  
  recoverChannel();
  delay(1);
}
