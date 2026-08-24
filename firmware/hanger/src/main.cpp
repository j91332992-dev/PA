#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <SPI.h>
#include <Preferences.h>
#include <esp_mac.h>
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
uint32_t sequence = 0, bootId = 0, lastHeartbeat = 0, lastScan = 0, lastBeacon = 0, ledUntil = 0, ledBlinkStartedAt = 0;
uint32_t lastCommandId = 0, lastCommandSequence = 0, lastCommandError = 0;
uint8_t channel = 1;
BLECharacteristic* bleStatusCharacteristic = nullptr;
bool bleActive = false;
int8_t serialLedTestPhase = -1;
uint32_t serialLedTestPhaseAt = 0;

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
// PN532 can occasionally miss a poll even while an NTAG remains in the
// antenna field.  Do not turn one such miss into an OUT event.
uint8_t noTagHits = 0;
uint32_t lastNfcInitAttemptMs = 0;
uint32_t lastNfcHealthCheckMs = 0;
uint32_t lastRawUidLogMs = 0;

// Channel lock state machine
enum class ChannelState { SEARCHING, LOCKED };
ChannelState channelState = ChannelState::SEARCHING;
uint8_t lastKnownGatewayChannel = 1;
uint32_t lastBeaconMs = 0;
uint32_t channelDwellStartMs = 0;

constexpr uint32_t CHANNEL_SEARCH_DWELL_MS = 450;
// Gateway cloud HTTPS calls are synchronous and can briefly delay ESP-NOW
// beacons. Keep the last Wi-Fi channel long enough that a Web FIND arriving
// during that delay is still received by this hanger.
constexpr uint32_t BEACON_LOST_TIMEOUT_MS = 30000;
constexpr uint32_t CHANNEL_RESCAN_TIMEOUT_MS = 90000;
uint32_t lastBeaconWarningMs = 0;
constexpr uint32_t PN532_REINIT_COOLDOWN_MS = 500;
// A passive NTAG answers immediately.  Keep no-tag polls short so removal
// does not keep the app in IN_WARDROBE for several 200ms timeouts.
constexpr uint16_t PN532_SCAN_TIMEOUT_MS = 80;
constexpr uint8_t REMOVE_CONFIRM_HITS = 3;
constexpr uint8_t PRESENT_CONFIRM_HITS = PRESENT_CONFIRM_COUNT < 1 ? 1 : PRESENT_CONFIRM_COUNT;
constexpr uint32_t FIND_REJECTED_EMPTY = 2;
constexpr uint32_t PN532_HEALTH_CHECK_MS = 1000;

sw::State state = sw::State::EMPTY;
bool nfcReady = false;

// The first production hanger was registered before the MAC-ID bug was
// discovered. Keep its existing cloud identity when that board is flashed
// with this firmware; all other boards use the last three bytes of their
// station MAC and therefore receive an independent hardware ID.
constexpr uint8_t LEGACY_HANGER_MAC[6] = {0xA0, 0xF2, 0x62, 0x86, 0xA0, 0xE8};
constexpr char LEGACY_HANGER_ID[] = "HC-62F2A0";

bool sameMac(const uint8_t* left, const uint8_t* right) {
  return memcmp(left, right, 6) == 0;
}

String hardwareHangerId(uint8_t mac[6]) {
  if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
    // This should not happen on an ESP32-C6, but retain a deterministic
    // fallback for unusual Arduino/IDF builds.
    uint64_t raw = ESP.getEfuseMac();
    memcpy(mac, &raw, 6);
  }

  if (sameMac(mac, LEGACY_HANGER_MAC)) return LEGACY_HANGER_ID;

  char id[16];
  snprintf(id, sizeof id, "HC-%02X%02X%02X", mac[3], mac[4], mac[5]);
  return id;
}

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
      // The BLE advertising name is always a neutral hardware label. Do not
      // persist an account or UI display name on a transferable hanger.
      prefs.remove("displayName");
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

void startSerialLedTest() {
  // A local test must not leave the production FIND timer active.
  ledUntil = 0;
  serialLedTestPhase = 0;
  serialLedTestPhaseAt = millis();
  Serial.println("[LED-TEST] START on=1000ms off=1000ms repeats=3");
  Serial.println("[LED-TEST] ON (1/3)");
}

void handleSerialDiagnostics() {
  if (!Serial.available()) return;
  String command = Serial.readStringUntil('\n');
  command.trim();
  if (command.equalsIgnoreCase("LEDTEST")) {
    startSerialLedTest();
  }
}

bool runSerialLedTest(uint32_t now) {
  if (serialLedTestPhase < 0) return false;
  while (serialLedTestPhase >= 0 && now - serialLedTestPhaseAt >= 1000) {
    serialLedTestPhaseAt += 1000;
    serialLedTestPhase++;
    if (serialLedTestPhase >= 6) {
      serialLedTestPhase = -1;
      Serial.println("[LED-TEST] COMPLETE");
      return true;
    }
    Serial.printf("[LED-TEST] %s (%u/3)\n", serialLedTestPhase % 2 == 0 ? "ON" : "OFF", serialLedTestPhase / 2 + 1);
  }
  led(serialLedTestPhase % 2 == 0);
  return true;
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
  // Once the garment tag leaves this hanger, a previous FIND must not keep
  // advertising an empty hanger.  Stop the real LED before reporting EMPTY.
  if (state == sw::State::EMPTY) {
    ledUntil = 0;
    ledBlinkStartedAt = 0;
    led(false);
    Serial.println("[LED] OFF: NFC tag removed");
  }
  char uHex[16] = "";
  for (uint8_t i = 0; i < currentLen; i++) snprintf(uHex + i * 2, 3, "%02X", currentUid[i]);
  Serial.printf("\n⚡ [STATE-CHANGE] state=%u (UID=%s len=%u)\n", unsigned(state), uHex, currentLen);
  setHangerBleStatus(state == sw::State::PRESENT ? "tag_present" : "tag_empty",
                     state == sw::State::PRESENT ? "옷 태그를 인식했습니다." : "현재 인식된 옷 태그가 없습니다.");
  report(true);
}

void ack(const sw::Packet& cmd, uint32_t errorCode = 0) {
  sw::Packet a;
  fill(a, sw::Type::ACK);
  strlcpy(a.gatewayId, cmd.gatewayId, sizeof a.gatewayId);
  a.commandId = cmd.commandId;
  a.errorFlags = errorCode;
  send(a);
  Serial.printf("[ACK-TX] %lu error=%lu\n", cmd.commandId, errorCode);
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
    if (hangerLinkDisabled) return;
    if (!pairedGateway.length()) {
      pairedGateway = discoveredGateway;
      prefs.putString("gateway", pairedGateway);
      Serial.printf("[GATEWAY] adopted gatewayId=%s\n", pairedGateway.c_str());
    }
    if (pairedGateway != discoveredGateway) return;

    const uint32_t now = millis();
    const bool wasConnected = (channelState == ChannelState::LOCKED) && (now - lastBeaconMs < BEACON_LOST_TIMEOUT_MS);
    lastBeaconMs = now;
    uint8_t gwCh = (uint8_t)p.errorFlags;
    if (gwCh >= 1 && gwCh <= 13) {
      if (channel != gwCh || channelState != ChannelState::LOCKED) {
        channel = gwCh;
        setChannel(channel);
        channelState = ChannelState::LOCKED;
        if (channel != prefs.getUChar("channel", 1)) {
          prefs.putUChar("channel", channel);
        }
        Serial.printf("[CHANNEL] Gateway beacon received %s ch=%u\n", discoveredGateway.c_str(), channel);
        Serial.printf("[CHANNEL] LOCKED ch=%u\n", channel);
      }
    }
    if (!wasConnected) {
      reportAfterGatewayBeacon = true;
      setHangerBleStatus("connected", "옷봉과 ESP-NOW로 연결되었습니다.");
    }
    return;
  }
  if (p.type == sw::Type::COMMAND) {
    const bool gatewayMatches = !pairedGateway.length() || pairedGateway == String(p.gatewayId);
    const bool targeted = sw::target(p, hanger.c_str());
    Serial.printf("[COMMAND-RX] id=%lu cmd=%u from=%s paired=%s target=%s ch=%u link=%s\n",
                  p.commandId, unsigned(p.command), p.gatewayId,
                  pairedGateway.c_str(), targeted ? "yes" : "no", channel,
                  hangerLinkDisabled ? "disabled" : "enabled");
    if (hangerLinkDisabled || !gatewayMatches || !targeted) {
      Serial.printf("[COMMAND-IGNORE] gateway-match=%s target=%s\n",
                    gatewayMatches ? "yes" : "no", targeted ? "yes" : "no");
      return;
    }
    // Gateway sends a short ESP-NOW burst and may re-poll the same Cloud
    // command. A duplicate must ACK but must never restart a blink or undo a
    // later NFC removal. Old sequence packets are discarded for the same
    // reason.
    if (p.commandId != 0 && p.commandId == lastCommandId) {
      ack(p, lastCommandError);
      return;
    }
    if (p.commandId != 0 && lastCommandSequence != 0 && p.sequence <= lastCommandSequence) {
      Serial.printf("[COMMAND-IGNORE] stale seq=%lu last=%lu id=%lu\n", p.sequence, lastCommandSequence, p.commandId);
      return;
    }
    if (p.commandId != 0) lastCommandSequence = p.sequence;
    Serial.printf("[COMMAND] %lu cmd=%u\n", p.commandId, (unsigned)p.command);
    uint32_t commandError = 0;
    if (p.command == sw::Command::LED_OFF) {
      ledUntil = 0;
      ledBlinkStartedAt = 0;
      led(false);
    } else if (p.command == sw::Command::LED_BLINK) {
      // Cloud retries can arrive after an NFC removal report.  Never let an
      // empty hanger revive its LED: a FIND is valid only for a confirmed
      // garment currently on this hanger.
      if (state != sw::State::PRESENT) {
        ledUntil = 0;
        ledBlinkStartedAt = 0;
        led(false);
        Serial.printf("[LED] REJECT FIND: no confirmed tag, id=%lu\n", p.commandId);
        commandError = FIND_REJECTED_EMPTY;
      } else {
        // The LED must visibly turn on before this command is acknowledged.
        // Use a command-relative phase so a FIND never starts in an OFF slice.
        ledBlinkStartedAt = millis();
        ledUntil = p.durationMs == 0 ? (ledBlinkStartedAt + LED_SAFETY_TIMEOUT_MS) : (ledBlinkStartedAt + p.durationMs);
        led(true);
      }
    }
    if (p.commandId != 0) {
      lastCommandId = p.commandId;
      lastCommandError = commandError;
    }
    ack(p, commandError);
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
  pinMode(PIN_NFC_SS, OUTPUT);
  digitalWrite(PIN_NFC_SS, HIGH);
  delay(10);

  // PN532 SPI Wakeup sequence: hold CS low for >2ms
  digitalWrite(PIN_NFC_SS, LOW);
  delay(5);
  digitalWrite(PIN_NFC_SS, HIGH);
  delay(10);

  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_NFC_SS);
  nfc.begin();
  delay(20);

  uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    // Additional wakeup pulse retry
    digitalWrite(PIN_NFC_SS, LOW);
    delay(10);
    digitalWrite(PIN_NFC_SS, HIGH);
    delay(20);
    version = nfc.getFirmwareVersion();
  }
  if (!version) {
    Serial.println("[NFC] INIT FAIL: GetFirmwareVersion");
    return false;
  }
  Serial.printf("[NFC] READY! SPI version=%08lX\n", version);
  nfc.SAMConfig();
  nfc.setPassiveActivationRetries(0xFF);
  nfcReady = true;
  setHangerBleStatus("nfc_ready", "옷 태그 읽기 장치가 준비되었습니다. 옷 태그를 대보세요.");
  return true;
}

// A bounded SPI poll leaves time for ESP-NOW event handling between scans.
int scanCard(uint8_t* uid, uint8_t& uidLen) {
  if (!nfcReady) {
    if (millis() - lastNfcInitAttemptMs < PN532_REINIT_COOLDOWN_MS) return -1;
    if (!tryInitNfc()) return -1;
  }
  uint8_t u1[7] = {0}, len1 = 0;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, u1, &len1, PN532_SCAN_TIMEOUT_MS) || len1 == 0 || len1 > 7) {
    return 0;
  }

  // Instant verification read to eliminate SPI bus noise
  uint8_t u2[7] = {0}, len2 = 0;
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, u2, &len2, 50) && len2 == len1) {
    if (memcmp(u1, u2, len1) == 0) {
      memcpy(uid, u1, len1);
      uidLen = len1;
      return 1;
    }
  }

  memcpy(uid, u1, len1);
  uidLen = len1;
  return 1;
}

void scanNfc() {
  uint8_t u[7] = {0}, len = 0;
  int res = scanCard(u, len);
  uint32_t now = millis();

  if (res == 1) {
    // === TAG FOUND ===
    noTagHits = 0;
    if (state == sw::State::PRESENT) {
      if (same(u, len, currentUid, currentLen)) {
        lastSeenMs = now; // Keep alive (Zero flapping)
        candidateHits = 0;
      } else {
        // Different tag reading while already in PRESENT: require 2 consecutive reads to switch
        if (same(u, len, candidateUid, candidateLen)) {
          if (++candidateHits >= PRESENT_CONFIRM_HITS) {
            memcpy(currentUid, candidateUid, candidateLen);
            currentLen = candidateLen;
            lastSeenMs = now;
            candidateHits = 0;
            logUid("[NFC] RAW UID=", currentUid, currentLen);
            transition(sw::State::PRESENT);
          }
        } else {
          memcpy(candidateUid, u, len);
          candidateLen = len;
          candidateHits = 1;
        }
      }
    } else {
      // A validated UID can re-enter immediately after the tag is returned.
      if (same(u, len, candidateUid, candidateLen)) {
        if (++candidateHits >= PRESENT_CONFIRM_HITS) {
          memcpy(currentUid, candidateUid, candidateLen);
          currentLen = candidateLen;
          lastSeenMs = now;
          candidateHits = 0;
          logUid("[NFC] RAW UID=", currentUid, currentLen);
          transition(sw::State::PRESENT);
        }
      } else {
        memcpy(candidateUid, u, len);
        candidateLen = len;
        candidateHits = 1;
      }
    }
  } else if (res == 0) {
    // === CLEAN NO TAG IN FIELD ===
    candidateHits = 0;
    if (state == sw::State::PRESENT) {
      // Require consecutive absent scans as well as the grace period. This
      // preserves PRESENT through a short PN532/RF miss, while a real removal
      // still stops FIND in well under a second with the current scan timing.
      if (noTagHits < 255) ++noTagHits;
      if (noTagHits >= REMOVE_CONFIRM_HITS && now - lastSeenMs >= REMOVE_GRACE_MS) {
        memset(currentUid, 0, sizeof(currentUid));
        currentLen = 0;
        memset(candidateUid, 0, sizeof(candidateUid));
        candidateLen = 0;
        candidateHits = 0;
        noTagHits = 0;
        transition(sw::State::EMPTY);
      }
    }
  } else {
    // A PN532 reinitialisation/read failure is not proof that the tag was
    // removed. Keep the last confirmed garment until clean no-tag scans say
    // otherwise, so the app cannot falsely move it outside the wardrobe.
    candidateHits = 0;
  }
}

void maintainChannel() {
  const uint32_t now = millis();
  if (channelState == ChannelState::LOCKED) {
    if (now - lastBeaconMs >= BEACON_LOST_TIMEOUT_MS) {
      // Keep using the last proven Gateway channel while HTTPS is briefly
      // blocking the S3 loop.  Sweeping channels immediately makes a Cloud
      // FIND miss the C6 even though both boards are still on channel 4.
      if (now - lastBeaconMs < CHANNEL_RESCAN_TIMEOUT_MS) {
        if (now - lastBeaconWarningMs >= BEACON_LOST_TIMEOUT_MS) {
          lastBeaconWarningMs = now;
          Serial.printf("[CHANNEL] Beacon delayed; holding ch=%u for FIND\n", channel);
        }
        return;
      }
      channelState = ChannelState::SEARCHING;
      channelDwellStartMs = now;
      Serial.println("[CHANNEL] Gateway beacon absent 90s -> SEARCHING");
    }
    return;
  }

  // In SEARCHING state:
  if (now - channelDwellStartMs < CHANNEL_SEARCH_DWELL_MS) return;
  channelDwellStartMs = now;
  channel = (channel >= 13) ? 1 : (channel + 1);
  setChannel(channel);
  Serial.printf("[CHANNEL] sweep ch=%u\n", channel);
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);
  delay(500);
  pinMode(PIN_LED, OUTPUT);
#ifdef LED_BUILTIN
  pinMode(LED_BUILTIN, OUTPUT);
#endif
  led(false);
  prefs.begin("hanger", false);
  uint8_t mac[6] = {0};
  const String generatedId = hardwareHangerId(mac);
  hanger = prefs.getString("hangerId", generatedId);
  if (!hanger.length()) {
    hanger = generatedId;
    prefs.putString("hangerId", hanger);
  }
  displayName = String("스마트 옷걸이 · ") + hanger.substring(hanger.length() - 6);
  prefs.remove("displayName");
  Serial.printf("[ID] base MAC=%02X:%02X:%02X:%02X:%02X:%02X hanger=%s%s\n",
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], hanger.c_str(),
                hanger == LEGACY_HANGER_ID ? " (legacy-preserved)" : "");
  bootId = esp_random();
  pairedGateway = prefs.getString("gateway", "");
  lastKnownGatewayChannel = prefs.getUChar("channel", 1);
  if (lastKnownGatewayChannel < 1 || lastKnownGatewayChannel > 13) lastKnownGatewayChannel = 1;
  channel = lastKnownGatewayChannel;
  // A reboot must not start sweeping away from the last paired S3 channel
  // while the S3 is in a cloud request.  Beacons will still correct the
  // channel immediately if the router moved it.
  channelState = pairedGateway.length() ? ChannelState::LOCKED : ChannelState::SEARCHING;
  lastBeaconMs = millis();
  channelDwellStartMs = millis();
  Serial.printf("[CHANNEL] trying last known ch=%u\n", channel);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  setChannel(channel);
  if (esp_now_init() != ESP_OK) {
    Serial.println("[BOOT] ESP-NOW init fail");
  }
  esp_now_register_recv_cb(receive);
  addBroadcast();

  startHangerBle();
  tryInitNfc();
  Serial.printf("[BOOT] %s channel=%u nfc=%s\n", hanger.c_str(), channel, nfcReady ? "READY" : "PENDING");
  setHangerBleStatus("booted", "옷걸이가 켜졌습니다. 옷봉 신호를 찾는 중입니다.");
  report(true);
}

void loop() {
  uint32_t t = millis();
  handleSerialDiagnostics();
  if (!runSerialLedTest(t)) {
    bool isBlinking = (t < ledUntil) && (((t - ledBlinkStartedAt) / 250) % 2 == 0);
    led(isBlinking);
  }

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
  
  maintainChannel();
  delay(1);
}
