#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>
#if __has_include("config.h")
#include "config.h"
#else
#error "Copy include/config.example.h to include/config.h and fill the values"
#endif
#include "protocol.h"

String gateway;
uint32_t beaconAt = 0, cloudAt = 0, gatewayHeartbeatAt = 0, wifiRetryAt = 0, sequence = 0;
Preferences wifiPrefs;
WebServer setupServer(80);
DNSServer setupDns;
bool setupPortalActive = false;
uint32_t rebootAt = 0;
BLECharacteristic* bleStatusCharacteristic = nullptr;
bool bleProvisioningActive = false;
bool bleWifiScanRequested = false;

constexpr char BLE_SERVICE_UUID[] = "a4e66a10-0fb0-4dce-8be0-18cf7bc82001";
constexpr char BLE_CONFIG_UUID[] = "a4e66a11-0fb0-4dce-8be0-18cf7bc82001";
constexpr char BLE_STATUS_UUID[] = "a4e66a12-0fb0-4dce-8be0-18cf7bc82001";

class GatewayBleServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer*) override {
    // Keep the device discoverable for the next browser connection. Without
    // this, reconnecting after a saved Wi-Fi setup can look like a long scan.
    BLEDevice::startAdvertising();
    Serial.println("[BLE] Advertising restarted");
  }
};
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
constexpr uint8_t EVENT_Q = 16, NORMAL_Q = 32, SEEN_Q = 16;
sw::Packet eventQueue[EVENT_Q], normalQueue[NORMAL_Q];
volatile uint8_t eventHead = 0, eventTail = 0, normalHead = 0, normalTail = 0;
struct SeenPacket { char hangerId[16]{}; uint32_t bootId = 0, sequence = 0; };
SeenPacket seenPackets[SEEN_Q];

String cloudBaseUrl() {
  String saved = wifiPrefs.getString("server", "");
  return saved.length() ? saved : String(CLOUD_BASE_URL);
}

String configuredSsid() {
  if (wifiPrefs.getBool("disabled", false)) return "";
  String saved = wifiPrefs.getString("ssid", "");
  return saved.length() ? saved : String(WIFI_SSID);
}

String configuredPassword() {
  String saved = wifiPrefs.getString("pass", "");
  return saved.length() ? saved : String(WIFI_PASSWORD);
}

void setBleStatus(const char* state, const char* message) {
  if (!bleStatusCharacteristic) return;
  JsonDocument status;
  status["state"] = state;
  status["message"] = message;
  String text;
  serializeJson(status, text);
  bleStatusCharacteristic->setValue(text.c_str());
  bleStatusCharacteristic->notify();
}

class BleConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String raw = characteristic->getValue();
    JsonDocument request;
    if (deserializeJson(request, raw)) {
      setBleStatus("error", "Wi-Fi 설정 형식이 올바르지 않습니다.");
      return;
    }
    const String action = request["action"] | "";
    if (action == "scan") {
      bleWifiScanRequested = true;
      setBleStatus("scanning", "옷봉이 주변 2.4 GHz Wi-Fi를 찾는 중입니다.");
      return;
    }
    if (action == "forget") {
      wifiPrefs.remove("ssid");
      wifiPrefs.remove("pass");
      wifiPrefs.remove("server");
      wifiPrefs.putBool("disabled", true);
      setBleStatus("forgotten", "저장된 옷봉 Wi-Fi 연결을 제거했습니다.");
      rebootAt = millis() + 2500;
      return;
    }
    const String ssid = request["ssid"] | "";
    const String password = request["password"] | "";
    const String server = request["server"] | "";
    if (!ssid.length() || !server.startsWith("http")) {
      setBleStatus("error", "2.4 GHz Wi-Fi 이름과 서버 주소를 확인하세요.");
      return;
    }
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("pass", password);
    wifiPrefs.putString("server", server);
    wifiPrefs.putBool("disabled", false);
    setBleStatus("saved", "저장되었습니다. 옷봉을 다시 연결합니다.");
    // Let the GATT write response and the final status notification reach the
    // browser before rebooting.  A short delay made successful saves appear as
    // generic browser-side GATT failures.
    rebootAt = millis() + 10000;
  }
};

void startBleProvisioning() {
  if (bleProvisioningActive) return;
  BLEDevice::init("Wardrobe-Rod");
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new GatewayBleServerCallbacks());
  BLEService* service = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic* config = service->createCharacteristic(BLE_CONFIG_UUID, BLECharacteristic::PROPERTY_WRITE);
  config->setCallbacks(new BleConfigCallbacks());
  bleStatusCharacteristic = service->createCharacteristic(
      BLE_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  bleProvisioningActive = true;
  setBleStatus("ready", "블루투스로 2.4 GHz Wi-Fi를 설정하세요.");
  Serial.println("[BLE] Ready: Wardrobe-Rod");
}

void scanNearbyWifiForBle() {
  if (!bleStatusCharacteristic) return;
  Serial.println("[BLE] Scanning nearby 2.4 GHz Wi-Fi networks");
  // Cancel a failed association before scanning. Otherwise the STA can keep a
  // stale channel lock and return only one nearby AP.
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  WiFi.scanDelete();
  delay(300);

  // Listen for AP beacons on every 2.4 GHz channel repeatedly. Results are
  // sent only for SSIDs the radio actually receives; no saved or guessed
  // network is injected.
  String seen = "|";
  uint8_t networkCount = 0;
  constexpr uint8_t SCAN_PASSES = 2;
  for (uint8_t pass = 0; pass < SCAN_PASSES; ++pass) {
    for (uint8_t channel = 1; channel <= 13; ++channel) {
      const int count = WiFi.scanNetworks(false, true, true, 850, channel);
      Serial.printf("[BLE] Wi-Fi scan pass=%u channel=%u result=%d\n", pass + 1, channel, count);
      if (count < 0) continue;
      for (int i = 0; i < count; ++i) {
        const String ssid = WiFi.SSID(i);
        const String marker = "|" + ssid + "|";
        if (!ssid.length() || seen.indexOf(marker) >= 0) continue;
        seen += marker;
        JsonDocument item;
        item["state"] = "network";
        item["ssid"] = ssid;
        item["rssi"] = WiFi.RSSI(i);
        item["channel"] = WiFi.channel(i);
        String message;
        serializeJson(item, message);
        bleStatusCharacteristic->setValue(message.c_str());
        bleStatusCharacteristic->notify();
        networkCount++;
        delay(80);
      }
      WiFi.scanDelete();
    }
    delay(250);
  }
  Serial.printf("[BLE] Full channel Wi-Fi scan result: %u network(s)\n", networkCount);
  setBleStatus("scan_complete", networkCount ? "주변 2.4 GHz Wi-Fi 목록을 불러왔습니다." : "주변 Wi-Fi를 찾지 못했습니다. 옷봉 위치와 전원을 확인하세요.");
}

void enqueue(const sw::Packet& p) {
  portENTER_CRITICAL(&mux);
  const bool priority = p.type == sw::Type::EVENT || p.type == sw::Type::ACK;
  if (priority) {
    uint8_t next = (eventHead + 1) % EVENT_Q;
    if (next != eventTail) {
      eventQueue[eventHead] = p;
      eventHead = next;
    }
  } else {
    uint8_t next = (normalHead + 1) % NORMAL_Q;
    if (next != normalTail) {
      normalQueue[normalHead] = p;
      normalHead = next;
    }
  }
  portEXIT_CRITICAL(&mux);
}

bool dequeue(sw::Packet& p) {
  bool ok = false;
  portENTER_CRITICAL(&mux);
  if (eventTail != eventHead) {
    p = eventQueue[eventTail];
    eventTail = (eventTail + 1) % EVENT_Q;
    ok = true;
  } else if (normalTail != normalHead) {
    p = normalQueue[normalTail];
    normalTail = (normalTail + 1) % NORMAL_Q;
    ok = true;
  }
  portEXIT_CRITICAL(&mux);
  return ok;
}

bool duplicateStatus(const sw::Packet& p) {
  if (p.type != sw::Type::STATUS && p.type != sw::Type::EVENT) return false;
  SeenPacket* slot = nullptr;
  for (auto& seen : seenPackets) {
    if (strncmp(seen.hangerId, p.hangerId, sizeof seen.hangerId) == 0) {
      if (seen.bootId == p.bootId && p.sequence <= seen.sequence) return true;
      slot = &seen;
      break;
    }
    if (!slot && !seen.hangerId[0]) slot = &seen;
  }
  if (!slot) slot = &seenPackets[p.sequence % SEEN_Q];
  strlcpy(slot->hangerId, p.hangerId, sizeof slot->hangerId);
  slot->bootId = p.bootId;
  slot->sequence = p.sequence;
  return false;
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
  Serial.printf("[ESPNOW-RX] Hanger=%s Type=%u State=%u Seq=%lu\n", p.hangerId, unsigned(p.type), unsigned(p.state), p.sequence);
  enqueue(p);
}

void addBroadcast() {
  esp_now_peer_info_t p{};
  memcpy(p.peer_addr, sw::BROADCAST, 6);
  p.channel = 0;
  p.ifidx = WIFI_IF_STA;
  if (!esp_now_is_peer_exist(sw::BROADCAST)) esp_now_add_peer(&p);
}

bool send(sw::Packet& p) {
  sw::seal(p);
  return esp_now_send(sw::BROADCAST, reinterpret_cast<uint8_t*>(&p), sizeof p) == ESP_OK;
}

String setupPage(const String& message = "") {
  String page = F("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Smart Wardrobe Wi-Fi</title><style>body{font:16px system-ui;margin:32px;max-width:520px;color:#19352b}input{box-sizing:border-box;width:100%;padding:12px;margin:6px 0 18px}button{background:#347454;color:white;border:0;border-radius:8px;padding:12px 18px;font-weight:700}.note{background:#eef6f0;padding:12px;border-radius:8px}</style><h1>Smart Wardrobe 연결</h1><p>2.4 GHz Wi-Fi 또는 휴대폰 핫스팟을 선택하세요. 5 GHz 전용 Wi-Fi에는 연결할 수 없습니다.</p>");
  if (message.length()) page += "<p class=note>" + message + "</p>";
  page += F("<form method=post action=/save><label>Wi-Fi 이름(SSID)</label><input name=ssid required maxlength=32><label>Wi-Fi 비밀번호</label><input name=pass type=password maxlength=63><label>서버 주소</label><input name=server required value='");
  page += cloudBaseUrl();
  page += F("'><p>예: http://192.168.0.49:8787</p><button>저장하고 연결</button></form>");
  return page;
}

bool connectWifi(const String& ssid, const String& password, uint32_t timeoutMs = 15000) {
  if (!ssid.length() || ssid == "YOUR_2_4_GHZ_WIFI") return false;
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.begin(ssid.c_str(), password.c_str());
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

void diagnoseWifi(const String& targetSsid) {
  Serial.printf("[WIFI] Diagnosing saved network: %s\n", targetSsid.c_str());
  // Clear the failed association before scanning.  Otherwise the ESP32-S3 can
  // return an empty scan after an unsuccessful WPA connection attempt.
  WiFi.disconnect(false, false);
  delay(250);
  // Use a longer active scan.  The default per-channel window was too short
  // for the nearby 2.4 GHz access point to appear reliably on this board.
  int count = WiFi.scanNetworks(false, true, false, 700, 0);
  if (count == 0) {
    delay(300);
    count = WiFi.scanNetworks(false, true, false, 700, 0);
  }
  Serial.printf("[WIFI] Full 2.4 GHz scan result: %d network(s)\n", count);
  if (count < 0) {
    Serial.println("[WIFI] Scan could not start; retrying after BLE setup.");
    return;
  }
  bool found = false;
  for (int i = 0; i < count; ++i) {
    if (WiFi.SSID(i) != targetSsid) continue;
    found = true;
    Serial.printf("[WIFI] Found saved network: channel=%d RSSI=%d dBm\n", WiFi.channel(i), WiFi.RSSI(i));
  }
  if (!found) Serial.println("[WIFI] Saved network is not visible. Check its exact name, 2.4 GHz setting, and distance.");
  WiFi.scanDelete();
}

void startSetupPortal() {
  if (setupPortalActive) return;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("SmartWardrobe-Setup", "wardrobe-setup");
  setupDns.start(53, "*", WiFi.softAPIP());
  setupServer.on("/", HTTP_GET, [] { setupServer.send(200, "text/html; charset=utf-8", setupPage()); });
  setupServer.on("/save", HTTP_POST, [] {
    const String ssid = setupServer.arg("ssid");
    const String password = setupServer.arg("pass");
    const String server = setupServer.arg("server");
    if (!ssid.length() || !server.startsWith("http")) {
      setupServer.send(400, "text/html; charset=utf-8", setupPage("Wi-Fi 이름과 http:// 서버 주소를 확인하세요."));
      return;
    }
    wifiPrefs.putString("ssid", ssid);
    wifiPrefs.putString("pass", password);
    wifiPrefs.putString("server", server);
    setupServer.send(200, "text/html; charset=utf-8", "<meta name=viewport content='width=device-width,initial-scale=1'><h2>저장했습니다.</h2><p>게이트웨이를 재시작하여 연결합니다.</p>");
    rebootAt = millis() + 1000;
  });
  setupServer.onNotFound([] {
    setupServer.sendHeader("Location", "http://192.168.4.1/", true);
    setupServer.send(302, "text/plain", "");
  });
  setupServer.begin();
  setupPortalActive = true;
  Serial.printf("[SETUP] Connect to SmartWardrobe-Setup, then open http://%s\n", WiFi.softAPIP().toString().c_str());
}

bool request(const String& path, const char* method, const String& payload, String& response, uint16_t timeoutMs = 1200, int* statusCode = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  // A fresh HTTPClient is created for every request, so reuse cannot retain a
  // connection and may leave a stale TCP session after hotspot changes.
  http.setReuse(false);
  String url = cloudBaseUrl() + path;
  http.begin(url);
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Gateway-Id", gateway);
  int code = !strcmp(method, "GET") ? http.GET() : http.POST(payload);
  if (statusCode) *statusCode = code;
  if (code > 0) response = http.getString();
  http.end();
  return code >= 200 && code < 300;
}

String stateName(sw::State s) {
  switch (s) {
    case sw::State::PRESENT: return "PRESENT";
    case sw::State::UNSTABLE: return "UNSTABLE";
    case sw::State::UNKNOWN_TAG: return "UNKNOWN_TAG";
    default: return "EMPTY";
  }
}

String uidHex(const sw::Packet& p) {
  String s;
  for (uint8_t i = 0; i < p.uidLength; i++) {
    char b[3];
    snprintf(b, 3, "%02X", p.uid[i]);
    s += b;
  }
  return s;
}

void upload(const sw::Packet& p) {
  JsonDocument d;
  d["gatewayId"] = gateway;
  d["hangerId"] = p.hangerId;
  d["state"] = stateName(p.state);
  d["tagUid"] = uidHex(p);
  d["sequence"] = p.sequence;
  d["bootId"] = p.bootId;
  d["channel"] = WiFi.channel();
  d["firmwareVersion"] = p.firmware;
  d["gatewayFirmwareVersion"] = "1.0.0";
  d["errorFlags"] = p.errorFlags;
  String body, out;
  serializeJson(d, body);
  int httpCode = 0;
  const uint16_t timeoutMs = p.type == sw::Type::EVENT ? 350 : 500;
  if (request("/api/gateway/status", "POST", body, out, timeoutMs, &httpCode)) {
    Serial.printf("[CLOUD] %s OK\n", p.hangerId);
  } else {
    Serial.printf("[CLOUD] %s FAIL http=%d\n", p.hangerId, httpCode);
  }
}

void gatewayHeartbeat() {
  JsonDocument d;
  d["gatewayId"] = gateway;
  d["channel"] = WiFi.channel();
  d["firmwareVersion"] = "1.0.0";
  String body, out;
  serializeJson(d, body);
  if (request("/api/gateway/heartbeat", "POST", body, out, 350)) {
    Serial.println("[CLOUD] gateway heartbeat OK");
  } else {
    Serial.println("[CLOUD] gateway heartbeat FAIL");
  }
}

void ack(const sw::Packet& p) {
  JsonDocument d;
  d["commandId"] = p.commandId;
  d["hangerId"] = p.hangerId;
  d["result"] = "OK";
  d["errorCode"] = p.errorFlags;
  String body, out;
  serializeJson(d, body);
  request("/api/gateway/ack", "POST", body, out, 350);
}

void fetchCommands() {
  String out;
  if (!request("/api/gateway/commands", "GET", "", out, 350)) return;
  JsonDocument doc;
  if (deserializeJson(doc, out)) return;
  for (JsonObject c : doc["commands"].as<JsonArray>()) {
    sw::Packet p;
    p.type = sw::Type::COMMAND;
    strlcpy(p.gatewayId, gateway.c_str(), sizeof p.gatewayId);
    p.sequence = ++sequence;
    p.commandId = c["numericId"] | 0;
    const char* cmdStr = c["command"] | "LED_BLINK";
    if (strcmp(cmdStr, "LED_OFF") == 0) {
      p.command = sw::Command::LED_OFF;
      p.durationMs = 0;
    } else {
      p.command = sw::Command::LED_BLINK;
      p.durationMs = c["durationMs"] | 0;
    }
    JsonArray targets = c["targets"];
    p.targetCount = min<size_t>(targets.size(), sw::MAX_TARGETS);
    for (uint8_t i = 0; i < p.targetCount; i++) p.targetIds[i] = sw::idCode(targets[i] | "");
    for (uint8_t i = 0; i < 2; i++) {
      send(p);
      if (i == 0) delay(10);
    }
    Serial.printf("[COMMAND] %lu cmd=%u targets=%u\n", p.commandId, (unsigned)p.command, p.targetCount);
  }
}

void beacon() {
  sw::Packet p;
  p.type = sw::Type::BEACON;
  strlcpy(p.gatewayId, gateway.c_str(), sizeof p.gatewayId);
  p.sequence = ++sequence;
  p.errorFlags = WiFi.channel();
  strlcpy(p.firmware, "1.0.0", sizeof p.firmware);
  send(p);
}

void wifi() {
  const String ssid = configuredSsid();
  Serial.printf("[WIFI] Connecting to %s...\n", ssid.c_str());
  if (connectWifi(ssid, configuredPassword())) {
    Serial.printf("[WIFI] CONNECTED IP=%s channel=%d\n", WiFi.localIP().toString().c_str(), WiFi.channel());
    return;
  }
  diagnoseWifi(ssid);
  Serial.println("[WIFI] No usable Wi-Fi. Starting BLE provisioning.");
}

void setup() {
  Serial.begin(115200);
  // ESP-NOW/cloud diagnostics are optional. Never let a closed USB monitor
  // stall packet forwarding while its serial buffer is full.
  Serial.setTxTimeoutMs(0);
  delay(500);
  uint64_t mac = ESP.getEfuseMac();
  char id[16];
  snprintf(id, sizeof id, "GW-%06llX", mac & 0xffffff);
  gateway = id;
  wifiPrefs.begin("wardrobe-wifi", false);
  // BLE stays available even after Wi-Fi succeeds, so first setup and later
  // router changes always use the same user-facing flow.  It must start
  // before a potentially slow saved-Wi-Fi retry, so it is discoverable
  // immediately after power-on.
  startBleProvisioning();
  wifi();
  if (esp_now_init() != ESP_OK) {
    Serial.println("[ERROR] ESP-NOW init");
    ESP.restart();
  }
  esp_now_register_recv_cb(receive);
  addBroadcast();
  Serial.printf("[BOOT] %s\n", gateway.c_str());
  beacon();
}

void loop() {
  if (setupPortalActive) {
    setupDns.processNextRequest();
    setupServer.handleClient();
  }
  if (rebootAt && millis() >= rebootAt) ESP.restart();
  if (bleWifiScanRequested) {
    bleWifiScanRequested = false;
    scanNearbyWifiForBle();
  }
  uint32_t t = millis();
  if (WiFi.status() != WL_CONNECTED && configuredSsid().length() && t - wifiRetryAt > 5000) {
    wifiRetryAt = t;
    Serial.println("[WIFI] reconnecting saved network");
    WiFi.reconnect();
  }
  
  // 1. Process pending ESP-NOW EVENTs / ACKs immediately!
  sw::Packet p;
  while (dequeue(p)) {
    if (duplicateStatus(p)) {
      Serial.printf("[ESPNOW] duplicate skipped Hanger=%s Seq=%lu\n", p.hangerId, p.sequence);
      continue;
    }
    if (p.type == sw::Type::ACK) {
      if (WiFi.status() == WL_CONNECTED) ack(p);
    } else if (p.type == sw::Type::STATUS || p.type == sw::Type::EVENT) {
      if (WiFi.status() == WL_CONNECTED) upload(p);
    }
  }

  // 2. Command polling (every 2.5s when queue is clear)
  if (WiFi.status() == WL_CONNECTED && t - cloudAt > 2500) {
    cloudAt = t;
    fetchCommands();
  }

  // A connected C3 must remain online even if no C6 tag packet arrived.
  if (WiFi.status() == WL_CONNECTED && t - gatewayHeartbeatAt > 8000) {
    gatewayHeartbeatAt = t;
    gatewayHeartbeat();
  }

  // 3. Beacon (every 0.5s). A hanger that rebooted or lost its channel can
  // re-lock quickly instead of waiting for a slow heartbeat cycle.
  if (t - beaconAt > 500) {
    beaconAt = t;
    beacon();
  }

  delay(2);
}
