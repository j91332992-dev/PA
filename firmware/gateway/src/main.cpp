#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <time.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <ArduinoJson.h>
#include <esp_crt_bundle.h>
#if __has_include("config.h")
#include "config.h"
#else
#error "Copy include/config.example.h to include/config.h and fill the values"
#endif
#ifndef CLOUD_TLS_ROOT_CA
#define CLOUD_TLS_ROOT_CA ""
#endif
#ifndef ALLOW_INSECURE_HTTP
#define ALLOW_INSECURE_HTTP 0
#endif
#include "protocol.h"

const char GOOGLE_ROOT_BUNDLE[] = 
"-----BEGIN CERTIFICATE-----\n"
"MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw\n"
"CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU\n"
"MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw\n"
"MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp\n"
"Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA\n"
"A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo\n"
"27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w\n"
"Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw\n"
"TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl\n"
"qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH\n"
"szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8\n"
"Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk\n"
"MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92\n"
"wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p\n"
"aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN\n"
"VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID\n"
"AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E\n"
"FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb\n"
"C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe\n"
"QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy\n"
"h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4\n"
"7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J\n"
"ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef\n"
"MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/\n"
"Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT\n"
"6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ\n"
"0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm\n"
"2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb\n"
"bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c\n"
"-----END CERTIFICATE-----\n"
"-----BEGIN CERTIFICATE-----\n"
"MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD\n"
"VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG\n"
"A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw\n"
"WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz\n"
"IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi\n"
"AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi\n"
"QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR\n"
"HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW\n"
"BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D\n"
"9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8\n"
"p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD\n"
"-----END CERTIFICATE-----\n"
"-----BEGIN CERTIFICATE-----\n"
"MIICjjCCAjOgAwIBAgIQf/NXaJvCTjAtkOGKQb0OHzAKBggqhkjOPQQDAjBQMSQw\n"
"IgYDVQQLExtHbG9iYWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkds\n"
"b2JhbFNpZ24xEzARBgNVBAMTCkdsb2JhbFNpZ24wHhcNMjMxMjEzMDkwMDAwWhcN\n"
"MjkwMjIwMTQwMDAwWjA7MQswCQYDVQQGEwJVUzEeMBwGA1UEChMVR29vZ2xlIFRy\n"
"dXN0IFNlcnZpY2VzMQwwCgYDVQQDEwNXRTEwWTATBgcqhkjOPQIBBggqhkjOPQMB\n"
"BwNCAARvzTr+Z1dHTCEDhUDCR127WEcPQMFcF4XGGTfn1XzthkubgdnXGhOlCgP4\n"
"mMTG6J7/EFmPLCaY9eYmJbsPAvpWo4IBAjCB/zAOBgNVHQ8BAf8EBAMCAYYwHQYD\n"
"VR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMBIGA1UdEwEB/wQIMAYBAf8CAQAw\n"
"HQYDVR0OBBYEFJB3kjVnxP+ozKnme9mAeXvMk/k4MB8GA1UdIwQYMBaAFFSwe61F\n"
"uOJAf/sKbvu+M8k8o4TVMDYGCCsGAQUFBwEBBCowKDAmBggrBgEFBQcwAoYaaHR0\n"
"cDovL2kucGtpLmdvb2cvZ3NyNC5jcnQwLQYDVR0fBCYwJDAioCCgHoYcaHR0cDov\n"
"L2MucGtpLmdvb2cvci9nc3I0LmNybDATBgNVHSAEDDAKMAgGBmeBDAECATAKBggq\n"
"hkjOPQQDAgNJADBGAiEAokJL0LgR6SOLR02WWxccAq3ndXp4EMRveXMUVUxMWSMC\n"
"IQDspFWa3fj7nLgouSdkcPy1SdOR2AGm9OQWs7veyXsBwA==\n"
"-----END CERTIFICATE-----\n";

String gateway;
uint32_t beaconAt = 0, cloudAt = 0, gatewayHeartbeatAt = 0, wifiRetryAt = 0, sequence = 0;
// Bound each idle Cloud poll so it cannot delay a physical NFC state edge.
// Render/Vercel TLS setup can take several hundred milliseconds on a cold
// request.  A 250 ms command timeout made every poll fail even while status
// uploads succeeded, so FIND commands stayed queued.  Keep polling often,
// but give the HTTPS request enough time to complete.
constexpr uint32_t COMMAND_POLL_INTERVAL_MS = 750;
constexpr uint16_t COMMAND_POLL_TIMEOUT_MS = 1200;
Preferences wifiPrefs;
WebServer setupServer(80);
DNSServer setupDns;
bool setupPortalActive = false;
uint32_t rebootAt = 0;
BLECharacteristic* bleStatusCharacteristic = nullptr;
BLECharacteristic* localStatusCharacteristic = nullptr;
bool bleProvisioningActive = false;
bool bleWifiScanRequested = false;
uint32_t bleAdvertiseRestartAt = 0;
String provisionState = "ready";
String provisionMessage = "블루투스로 옷봉을 연결하세요.";

constexpr char BLE_SERVICE_UUID[] = "a4e66a10-0fb0-4dce-8be0-18cf7bc82001";
constexpr char BLE_CONFIG_UUID[] = "a4e66a11-0fb0-4dce-8be0-18cf7bc82001";
constexpr char BLE_STATUS_UUID[] = "a4e66a12-0fb0-4dce-8be0-18cf7bc82001";
constexpr char LOCAL_STATUS_UUID[] = "a4e66a13-0fb0-4dce-8be0-18cf7bc82001";
constexpr char LOCAL_COMMAND_UUID[] = "a4e66a14-0fb0-4dce-8be0-18cf7bc82001";
String stateName(sw::State s);
String uidHex(const sw::Packet& p);
void sendLocalCommand(const String& command, const JsonArrayConst& targets, uint16_t durationMs);

class GatewayBleServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer*) override {
    // The controller may still be releasing the old GATT handle when this
    // callback fires. Restarting immediately can leave the S3 invisible to a
    // second phone/account; defer it to the main loop after the stack settles.
    bleAdvertiseRestartAt = millis() + 250;
    Serial.println("[BLE] Client disconnected; advertising restart queued");
  }
};
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
constexpr uint8_t EVENT_Q = 16, NORMAL_Q = 32, SEEN_Q = 16;
sw::Packet eventQueue[EVENT_Q], normalQueue[NORMAL_Q];
volatile uint8_t eventHead = 0, eventTail = 0, normalHead = 0, normalTail = 0;
struct SeenPacket {
  char hangerId[16]{};
  uint32_t bootId = 0, sequence = 0;
};
SeenPacket seenPackets[SEEN_Q];

String cloudBaseUrl() {
  String saved = wifiPrefs.getString("server", "");
  if (saved.length()) {
    // Older firmware stored a local http:// address.  Once secure cloud mode
    // is enabled, keeping that value would make a perfectly healthy gateway
    // look offline forever.  Keep valid HTTPS settings, but self-heal the
    // obsolete insecure value using the configured production URL.
    // The temporary Cloudflare tunnel used during development disappears when
    // the PC is off. Move existing rods to the permanent OTKOK production
    // endpoint automatically after this firmware update.
    if (saved == "https://otkok.vercel.app" || saved.indexOf(".trycloudflare.com") >= 0 || saved.indexOf("onrender.com") >= 0) {
      wifiPrefs.putString("server", CLOUD_BASE_URL);
      Serial.println("[CLOUD] Replaced legacy temporary server URL with OTKOK production");
      return String(CLOUD_BASE_URL);
    }
    if (saved.startsWith("https://") || ALLOW_INSECURE_HTTP) return saved;
    wifiPrefs.putString("server", CLOUD_BASE_URL);
    Serial.println("[CLOUD] Replaced legacy HTTP server URL with secure default");
  }
  return String(CLOUD_BASE_URL);
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

String bleDisplayName() {
  // BLE is a setup/discovery channel, not an ownership display. Never keep a
  // previous account name in NVS: the immutable hardware suffix distinguishes
  // multiple nearby rods before any server-side claim occurs.
  return String("스마트 옷봉 · ") + gateway.substring(gateway.length() - 6);
}

// The ESP32 default regulatory domain can exclude channels 12/13.  A Korean
// home router may legally advertise its 2.4 GHz SSID on either of those
// channels, so a default (US) scan can report zero networks even though the
// PC and phone can see the access point.  Lock the radio to the Korean domain
// before every setup/association scan so all channels 1–13 are searched.
void configureWifiCountry() {
  wifi_country_t country{};
  strlcpy(country.cc, "KR", sizeof(country.cc));
  country.schan = 1;
  country.nchan = 13;
  country.max_tx_power = 84; // 21 dBm, ESP32-S3 legal maximum for KR
  country.policy = WIFI_COUNTRY_POLICY_MANUAL;
  const esp_err_t result = esp_wifi_set_country(&country);
  if (result != ESP_OK) {
    Serial.printf("[WIFI] Korean country/channel setup failed: %s\n", esp_err_to_name(result));
  } else {
    Serial.println("[WIFI] Country KR configured (2.4 GHz channels 1-13)");
  }
}

void setBleStatus(const char* state, const char* message) {
  provisionState = state;
  provisionMessage = message;
  if (!bleStatusCharacteristic) return;
  JsonDocument status;
  status["state"] = state;
  status["message"] = message;
  status["gatewayId"] = gateway;
  String text;
  serializeJson(status, text);
  bleStatusCharacteristic->setValue(text.c_str());
  bleStatusCharacteristic->notify();
}

bool send(sw::Packet& p);

// Keep the JSON-heavy provisioning work outside the BLE virtual callback.
// Recent ESP32-S3 GCC builds can otherwise hit an internal compiler error
// while optimizing the callback body.
void processBleWrite(BLECharacteristic* characteristic) {
  const String raw = characteristic->getValue();
  JsonDocument request;
  if (deserializeJson(request, raw)) {
    setBleStatus("error", "Wi-Fi 설정 형식이 올바르지 않습니다.");
    return;
  }
  const String action = request["action"] | "";
  if (action == "status") {
    setBleStatus(provisionState.c_str(), provisionMessage.c_str());
    return;
  }
  if (action == "local_find" || action == "local_off") {
    sendLocalCommand(action, request["targets"].as<JsonArrayConst>(), request["durationMs"] | 0);
    return;
  }
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
  if (action == "factory_reset") {
    // Release all C6 hangers first while this S3 is still on their ESP-NOW
    // channel.  Afterwards it clears the Wi-Fi/cloud setup and cannot silently
    // reconnect to the previous account.
    sw::Packet packet;
    packet.type = sw::Type::COMMAND;
    strlcpy(packet.gatewayId, gateway.c_str(), sizeof packet.gatewayId);
    packet.sequence = ++sequence;
    packet.commandId = ++sequence;
    packet.command = sw::Command::UNPAIR;
    packet.targetCount = 0; // paired C6 units interpret this as "release all".
    for (uint8_t i = 0; i < 8; ++i) { send(packet); delay(20); }
    wifiPrefs.clear();
    wifiPrefs.putBool("disabled", true);
    setBleStatus("factory_reset", "옷봉과 연결된 옷걸이, Wi-Fi 및 계정 연결을 초기화했습니다.");
    rebootAt = millis() + 3000;
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
  wifiPrefs.remove("displayName");
  wifiPrefs.putBool("disabled", false);
  setBleStatus("saved", "저장되었습니다. 옷봉을 다시 연결합니다.");
  rebootAt = millis() + 10000;
}

class BleConfigCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override { processBleWrite(characteristic); }
};

void startBleProvisioning() {
  if (bleProvisioningActive) return;
  const String displayName = bleDisplayName();
  BLEDevice::init(displayName.c_str());
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new GatewayBleServerCallbacks());
  BLEService* service = server->createService(BLE_SERVICE_UUID);
  BLECharacteristic* config = service->createCharacteristic(BLE_CONFIG_UUID, BLECharacteristic::PROPERTY_WRITE);
  config->setCallbacks(new BleConfigCallbacks());
  bleStatusCharacteristic = service->createCharacteristic(
      BLE_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  localStatusCharacteristic = service->createCharacteristic(
      LOCAL_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  service->createCharacteristic(LOCAL_COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE)->setCallbacks(new BleConfigCallbacks());
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  bleProvisioningActive = true;
  setBleStatus("ready", "블루투스로 2.4 GHz Wi-Fi를 설정하세요.");
  Serial.printf("[BLE] Ready: %s\n", displayName.c_str());
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
  configureWifiCountry();
  WiFi.scanDelete();
  delay(300);

  // A single full active scan (channel 0) lets the ESP32 radio cover every
  // 2.4 GHz channel without holding the BLE setup screen for 20+ seconds.
  // One 220 ms dwell per channel is enough for normal beacon intervals; users
  // can press "다시 검색" again when a router is waking up.
  String seen = "|";
  uint8_t networkCount = 0;
  constexpr uint8_t SCAN_PASSES = 1;
  for (uint8_t pass = 0; pass < SCAN_PASSES; ++pass) {
    int count = WiFi.scanNetworks(false, true, false, 220, 0);
    Serial.printf("[BLE] Wi-Fi full active scan pass=%u result=%d\n", pass + 1, count);
    // A beacon can fall just outside a single dwell window while the radio
    // was switching away from BLE. Retry only the empty result so normal
    // scans stay fast but a waking router is not silently omitted.
    if (count == 0) {
      WiFi.scanDelete();
      delay(120);
      count = WiFi.scanNetworks(false, true, false, 220, 0);
      Serial.printf("[BLE] Wi-Fi retry after empty result=%d\n", count);
    }
    if (count >= 0) for (int i = 0; i < count; ++i) {
      const String ssid = WiFi.SSID(i);
      Serial.printf("[BLE-SCAN] ssid=%s ch=%d rssi=%d\n", ssid.length() ? ssid.c_str() : "<hidden>", WiFi.channel(i), WiFi.RSSI(i));
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
      delay(40);
    }
    WiFi.scanDelete();
    if (pass + 1 < SCAN_PASSES) delay(150);
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
  portENTER_CRITICAL(&mux);
  SeenPacket* slot = nullptr;
  for (auto& seen : seenPackets) {
    if (strncmp(seen.hangerId, p.hangerId, sizeof seen.hangerId) == 0) {
      if (seen.bootId == p.bootId && p.sequence <= seen.sequence) {
        portEXIT_CRITICAL(&mux);
        return true;
      }
      slot = &seen;
      break;
    }
    if (!slot && !seen.hangerId[0]) slot = &seen;
  }
  if (!slot) slot = &seenPackets[p.sequence % SEEN_Q];
  strlcpy(slot->hangerId, p.hangerId, sizeof slot->hangerId);
  slot->bootId = p.bootId;
  slot->sequence = p.sequence;
  portEXIT_CRITICAL(&mux);
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
  if (localStatusCharacteristic && (p.type == sw::Type::EVENT || p.type == sw::Type::STATUS)) {
    JsonDocument local;
    local["type"] = "hanger_state";
    local["hangerId"] = p.hangerId;
    local["state"] = stateName(p.state);
    local["tagUid"] = uidHex(p);
    local["sequence"] = p.sequence;
    local["errorFlags"] = p.errorFlags;
    String message;
    serializeJson(local, message);
    localStatusCharacteristic->setValue(message.c_str());
    localStatusCharacteristic->notify();
  }
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
  const esp_err_t result = esp_now_send(sw::BROADCAST, reinterpret_cast<uint8_t*>(&p), sizeof p);
  if (result != ESP_OK && (p.type == sw::Type::COMMAND || p.type == sw::Type::BEACON)) {
    Serial.printf("[ESPNOW-TX] type=%u commandId=%lu enqueue-error=%d ch=%d\n",
                  unsigned(p.type), p.commandId, int(result), WiFi.channel());
  }
  return result == ESP_OK;
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
  // A previous reconnect can still be in progress after a failed association.
  // Starting WiFi.begin() on top of it leaves the S3 stuck in STA_CONNECTING.
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect(false, true);
    delay(250);
  }
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  configureWifiCountry();
  WiFi.begin(ssid.c_str(), password.c_str());
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) delay(100);
  if (WiFi.status() == WL_CONNECTED) {
    IPAddress dns1(8, 8, 8, 8), dns2(1, 1, 1, 1);
    WiFi.config(WiFi.localIP(), WiFi.gatewayIP(), WiFi.subnetMask(), dns1, dns2);
    return true;
  }
  Serial.printf("[WIFI] Connection attempt ended with status=%d\n", WiFi.status());
  return false;
}

bool diagnoseWifi(const String& targetSsid) {
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
    return false;
  }
  bool found = false;
  for (int i = 0; i < count; ++i) {
    if (WiFi.SSID(i).length()) {
      Serial.printf("[SCAN] %s (ch=%d, rssi=%d)\n", WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i));
    }
    if (WiFi.SSID(i) != targetSsid) continue;
    found = true;
    Serial.printf("[WIFI] Found saved network: channel=%d RSSI=%d dBm\n", WiFi.channel(i), WiFi.RSSI(i));
  }
  if (!found) Serial.println("[WIFI] Saved network is not visible. Check its exact name, 2.4 GHz setting, and distance.");
  WiFi.scanDelete();
  return found;
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

bool request(const String& path, const char* method, const String& payload, String& response, uint16_t timeoutMs = 5000, int* statusCode = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(timeoutMs / 1000 + 1);

  String base = cloudBaseUrl();
  String host = "smart-wardrobe-api-dhb4.onrender.com";
  uint16_t port = 443;
  if (base.indexOf("://") > 0) {
    String noProto = base.substring(base.indexOf("://") + 3);
    int slash = noProto.indexOf('/');
    if (slash > 0) noProto = noProto.substring(0, slash);
    int colon = noProto.indexOf(':');
    if (colon > 0) {
      host = noProto.substring(0, colon);
      port = (uint16_t)noProto.substring(colon + 1).toInt();
    } else {
      host = noProto;
    }
  }

  // Bound both TLS connect and response waiting. A slow command poll must not
  // hold a just-arrived NFC PRESENT/EMPTY event for several seconds.
  if (!client.connect(host.c_str(), port, timeoutMs)) {
    char err[64]{};
    client.lastError(err, sizeof err);
    Serial.printf("[CLOUD] TLS connect failed: %s\n", err);
    if (statusCode) *statusCode = -1;
    return false;
  }

  String req = String(method) + " " + path + " HTTP/1.1\r\n" +
               "Host: " + host + "\r\n" +
               "User-Agent: SmartWardrobe-Gateway\r\n" +
               "Authorization: Bearer " + DEVICE_TOKEN + "\r\n" +
               "X-Gateway-Id: " + gateway + "\r\n" +
               "Content-Type: application/json\r\n" +
               "Content-Length: " + String(payload.length()) + "\r\n" +
               "Connection: close\r\n\r\n" +
               payload;

  client.print(req);
  client.flush();

  uint32_t start = millis();
  while (!client.available() && millis() - start < timeoutMs) {
    delay(10);
  }
  if (!client.available()) {
    Serial.printf("[CLOUD] No response from %s (connected=%d)\n", path.c_str(), client.connected());
    client.stop();
    if (statusCode) *statusCode = -2;
    return false;
  }

  String statusLine = client.readStringUntil('\n');
  int code = 0;
  if (statusLine.startsWith("HTTP/1.")) {
    int sp1 = statusLine.indexOf(' ');
    if (sp1 > 0) {
      code = statusLine.substring(sp1 + 1, sp1 + 4).toInt();
    }
  }
  if (statusCode) *statusCode = code;

  int contentLength = -1;
  while (true) {
    String header = client.readStringUntil('\n');
    header.trim();
    if (header.length() == 0) break;
    const String lower = header.substring(0, min<size_t>(header.length(), 15));
    if (lower.equalsIgnoreCase("content-length:")) {
      contentLength = header.substring(header.indexOf(':') + 1).toInt();
    }
  }

  // Render may send the JSON body just after the response headers.  Do not
  // treat an empty receive buffer at that instant as an empty command list.
  response = "";
  start = millis();
  while (millis() - start < timeoutMs) {
    while (client.available()) response += (char)client.read();
    if (contentLength >= 0 && response.length() >= contentLength) break;
    if (!client.connected() && !client.available()) break;
    delay(5);
  }
  client.stop();
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
  // State edges are latency-sensitive. Fail fast and let the C6 heartbeat
  // retry rather than blocking the next PRESENT/EMPTY edge for seconds.
  const uint16_t timeoutMs = 600;
  if (request("/api/gateway/status", "POST", body, out, timeoutMs, &httpCode)) {
    Serial.printf("[CLOUD] %s OK\n", p.hangerId);
  } else {
    Serial.printf("[CLOUD] %s FAIL http=%d\n", p.hangerId, httpCode);
  }
}

void sendLocalCommand(const String& command, const JsonArrayConst& targets, uint16_t durationMs) {
  const uint8_t count = min<size_t>(targets.size(), sw::MAX_TARGETS);
  if (!count) return;
  sw::Packet p;
  p.type = sw::Type::COMMAND;
  strlcpy(p.gatewayId, gateway.c_str(), sizeof p.gatewayId);
  p.sequence = ++sequence;
  p.commandId = ++sequence;
  p.command = command == "local_off" ? sw::Command::LED_OFF : sw::Command::LED_BLINK;
  p.durationMs = p.command == sw::Command::LED_OFF ? 0 : min<uint16_t>(durationMs, 60000);
  p.targetCount = count;
  for (uint8_t i = 0; i < count; ++i) p.targetIds[i] = sw::idCode(targets[i] | "");
  // Local BLE commands bypass HTTP completely; a short radio burst handles a
  // C6 that is just relocking its ESP-NOW channel.
  for (uint8_t i = 0; i < 4; ++i) { send(p); if (i < 3) delay(15); }
  Serial.printf("[LOCAL-BLE] cmd=%u targets=%u\n", unsigned(p.command), p.targetCount);
}

void uploadBatch(const sw::Packet* packets, uint8_t count) {
  JsonDocument d;
  JsonArray items = d["items"].to<JsonArray>();
  for (uint8_t i = 0; i < count; ++i) {
    const sw::Packet& p = packets[i];
    JsonObject item = items.add<JsonObject>();
    item["gatewayId"] = gateway;
    item["hangerId"] = p.hangerId;
    item["state"] = stateName(p.state);
    item["tagUid"] = uidHex(p);
    item["sequence"] = p.sequence;
    item["bootId"] = p.bootId;
    item["channel"] = WiFi.channel();
    item["firmwareVersion"] = p.firmware;
    item["gatewayFirmwareVersion"] = "1.0.0";
    item["errorFlags"] = p.errorFlags;
  }
  String body, out;
  serializeJson(d, body);
  int httpCode = 0;
  if (!request("/api/gateway/status/batch", "POST", body, out, 600, &httpCode)) {
    Serial.printf("[CLOUD] batch FAIL count=%u http=%d\n", count, httpCode);
  }
}

void gatewayHeartbeat() {
  JsonDocument d;
  d["gatewayId"] = gateway;
  d["channel"] = WiFi.channel();
  d["firmwareVersion"] = "1.0.0";
  d["ssid"] = WiFi.SSID();
  d["rssi"] = WiFi.RSSI();
  d["ip"] = WiFi.localIP().toString();
  String body, out;
  serializeJson(d, body);
  int httpCode = 0;
  if (request("/api/gateway/heartbeat", "POST", body, out, 2500, &httpCode)) {
    Serial.println("[CLOUD] gateway heartbeat OK");
    setBleStatus("server_connected", "옷봉이 인터넷과 내 옷장 서버에 연결되었습니다.");
  } else {
    Serial.printf("[CLOUD] gateway heartbeat FAIL http=%d\n", httpCode);
    if (httpCode == 401 || httpCode == 403) {
      setBleStatus("server_auth_failed", "서버 등록 정보를 확인해야 합니다. 관리자 설정이 필요합니다.");
    } else {
      setBleStatus("server_connection_failed", "Wi-Fi는 연결되었지만 내 옷장 서버에 닿지 못했습니다. 잠시 후 다시 확인하세요.");
    }
  }
}

void ack(const sw::Packet& p) {
  if (p.commandId == 0) {
    Serial.printf("[FIND-TEST] ACK from %s\n", p.hangerId);
    return;
  }
  JsonDocument d;
  d["commandId"] = p.commandId;
  d["hangerId"] = p.hangerId;
  // A C6 may reject a delayed FIND after its tag has been removed. Preserve
  // that result in Cloud rather than incorrectly marking the command ACKED.
  d["result"] = p.errorFlags == 0 ? "OK" : "ERROR";
  d["errorCode"] = p.errorFlags;
  String body, out;
  serializeJson(d, body);
  request("/api/gateway/ack", "POST", body, out, 2500);
}

void runFindTest(const String& hangerId) {
  String target = hangerId;
  target.trim();
  if (!target.startsWith("HC-") || target.length() < 9) {
    Serial.println("[FIND-TEST] usage: FINDTEST HC-XXXXXX");
    return;
  }
  sw::Packet p;
  p.type = sw::Type::COMMAND;
  strlcpy(p.gatewayId, gateway.c_str(), sizeof p.gatewayId);
  p.sequence = ++sequence;
  p.commandId = 0; // Reserved local diagnostic command: never sent to Cloud ACK.
  p.command = sw::Command::LED_BLINK;
  p.durationMs = 6000;
  p.targetCount = 1;
  p.targetIds[0] = sw::idCode(target.c_str());
  for (uint8_t i = 0; i < 2; ++i) {
    send(p);
    if (i == 0) delay(10);
  }
  Serial.printf("[FIND-TEST] sent target=%s blink=6000ms\n", target.c_str());
}

void handleSerialDiagnostics() {
  if (!Serial.available()) return;
  String command = Serial.readStringUntil('\n');
  command.trim();
  if (command.startsWith("FINDTEST")) {
    runFindTest(command.substring(String("FINDTEST").length()));
    return;
  }
  // USB-only recovery for a gateway whose application was updated without
  // retaining its Wi-Fi NVS.  The password is never printed to Serial.
  // Format: WIFI <ssid>\t<password>\t<server-url>
  if (!command.startsWith("WIFI ")) return;
  const String args = command.substring(5);
  const int firstTab = args.indexOf('\t');
  const int secondTab = firstTab < 0 ? -1 : args.indexOf('\t', firstTab + 1);
  if (firstTab <= 0 || secondTab <= firstTab + 1) {
    Serial.println("[WIFI] usage: WIFI <ssid>\\t<password>\\t<server-url>");
    return;
  }
  const String ssid = args.substring(0, firstTab);
  const String password = args.substring(firstTab + 1, secondTab);
  const String server = args.substring(secondTab + 1);
  if (!ssid.length() || !server.startsWith("http")) {
    Serial.println("[WIFI] invalid SSID or server URL");
    return;
  }
  wifiPrefs.putString("ssid", ssid);
  wifiPrefs.putString("pass", password);
  wifiPrefs.putString("server", server);
  wifiPrefs.putBool("disabled", false);
  Serial.printf("[WIFI] credentials saved for %s; rebooting\n", ssid.c_str());
  rebootAt = millis() + 500;
}

bool decodeChunkedBody(const String& encoded, String& decoded) {
  decoded = "";
  size_t at = 0;
  while (at < encoded.length()) {
    const int lineEnd = encoded.indexOf("\r\n", at);
    if (lineEnd < 0) return false;
    const String hexLength = encoded.substring(at, lineEnd);
    char* end = nullptr;
    const unsigned long chunkLength = strtoul(hexLength.c_str(), &end, 16);
    if (!end || *end != '\0') return false;
    at = lineEnd + 2;
    if (chunkLength == 0) return true;
    if (at + chunkLength + 2 > encoded.length()) return false;
    decoded += encoded.substring(at, at + chunkLength);
    at += chunkLength;
    if (encoded.substring(at, at + 2) != "\r\n") return false;
    at += 2;
  }
  return false;
}

void fetchCommands() {
  String out;
  // The server returns this response before its asynchronous status save.  A
  // bounded timeout keeps command polling responsive without starving beacons.
  // The next poll follows quickly. Prefer a bounded physical-state latency to
  // waiting several seconds for one stale/slow command response.
  if (!request("/api/gateway/commands", "GET", "", out, COMMAND_POLL_TIMEOUT_MS)) {
    Serial.println("[COMMAND-POLL] HTTP request failed");
    return;
  }
  String jsonBody = out;
  String decoded;
  if (decodeChunkedBody(out, decoded)) jsonBody = decoded;
  JsonDocument doc;
  const DeserializationError parseError = deserializeJson(doc, jsonBody);
  if (parseError) {
    Serial.printf("[COMMAND-POLL] JSON parse failed=%s bytes=%u\n", parseError.c_str(), jsonBody.length());
    Serial.print("[COMMAND-POLL] first-bytes=");
    for (size_t i = 0; i < min<size_t>(out.length(), 24); i++) Serial.printf("%02X", uint8_t(out[i]));
    Serial.println();
    return;
  }
  const JsonArray commands = doc["commands"].as<JsonArray>();
  if (!commands.size()) {
    Serial.printf("[COMMAND-POLL] received empty queue bytes=%u\n", out.length());
  }
  for (JsonObject c : commands) {
    sw::Packet p;
    p.type = sw::Type::COMMAND;
    strlcpy(p.gatewayId, gateway.c_str(), sizeof p.gatewayId);
    p.sequence = ++sequence;
    p.commandId = c["numericId"] | 0;
    const char* cmdStr = c["command"] | "LED_BLINK";
    const bool factoryReset = strcmp(cmdStr, "FACTORY_RESET") == 0;
    if (factoryReset || strcmp(cmdStr, "UNPAIR") == 0) {
      p.command = sw::Command::UNPAIR;
      p.durationMs = 0;
    } else if (strcmp(cmdStr, "PAIR") == 0) {
      p.command = sw::Command::PAIR;
      p.durationMs = 0;
    } else if (strcmp(cmdStr, "LED_OFF") == 0) {
      p.command = sw::Command::LED_OFF;
      p.durationMs = 0;
    } else {
      p.command = sw::Command::LED_BLINK;
      p.durationMs = c["durationMs"] | 0;
    }
    JsonArray targets = c["targets"];
    p.targetCount = min<size_t>(targets.size(), sw::MAX_TARGETS);
    for (uint8_t i = 0; i < p.targetCount; i++) p.targetIds[i] = sw::idCode(targets[i] | "");
    // The C6 can be completing an ESP-NOW channel relock when a cloud command
    // arrives. A short burst makes a real FIND reliable without changing its
    // command ID or producing a second cloud command.
    const uint8_t burstCount = (p.command == sw::Command::UNPAIR || p.command == sw::Command::PAIR) ? 8 : 6;
    for (uint8_t i = 0; i < burstCount; i++) {
      send(p);
      if (i + 1 < burstCount) delay(30);
    }
    if (factoryReset) {
      wifiPrefs.clear();
      wifiPrefs.putBool("disabled", true);
      Serial.println("[REMOTE-RESET] Cloud deletion applied; clearing Wi-Fi and paired hangers");
      rebootAt = millis() + 500;
      return;
    }
    Serial.printf("[COMMAND] %lu cmd=%u targets=%u", p.commandId, (unsigned)p.command, p.targetCount);
    for (uint8_t i = 0; i < p.targetCount; ++i) Serial.printf(" id%u=%lu", unsigned(i + 1), (unsigned long)p.targetIds[i]);
    Serial.println();
  }
}

void beacon() {
  const uint8_t ch = WiFi.channel();
  if (ch < 1 || ch > 13) return;
  sw::Packet p;
  p.type = sw::Type::BEACON;
  strlcpy(p.gatewayId, gateway.c_str(), sizeof p.gatewayId);
  p.sequence = ++sequence;
  p.errorFlags = ch;
  strlcpy(p.firmware, "1.0.0", sizeof p.firmware);
  send(p);
}

bool syncTlsClock() {
  // TLS certificate validation needs a real clock.  A newly powered ESP32 has
  // no battery-backed time, so HTTPS otherwise fails with the unhelpful -1.
  if (time(nullptr) > 1700000000) return true;
  Serial.println("[TIME] Syncing clock for secure server connection...");
  configTime(9 * 3600, 0, "time.google.com", "pool.ntp.org");
  const uint32_t started = millis();
  while (time(nullptr) <= 1700000000 && millis() - started < 8000) delay(150);
  const bool ready = time(nullptr) > 1700000000;
  Serial.println(ready ? "[TIME] Clock ready" : "[TIME] Clock sync pending; will retry cloud requests");
  return ready;
}

void testDirectTls() {
  WiFiClientSecure client;
  client.setInsecure();
  Serial.println("[TEST] Connecting directly to smart-wardrobe-api-dhb4.onrender.com:443...");
  if (!client.connect("smart-wardrobe-api-dhb4.onrender.com", 443)) {
    char err[128]{};
    client.lastError(err, sizeof err);
    Serial.printf("[TEST] TLS connect failed! detail: %s\n", err);
    return;
  }
  Serial.println("[TEST] TLS connected! Sending HTTP GET /api/health...");
  client.print("GET /api/health HTTP/1.1\r\nHost: smart-wardrobe-api-dhb4.onrender.com\r\nUser-Agent: ESP32-S3\r\nConnection: close\r\n\r\n");
  uint32_t start = millis();
  while ((client.connected() || client.available()) && millis() - start < 6000) {
    while (client.available()) {
      char c = client.read();
      Serial.write(c);
    }
    delay(10);
  }
  client.stop();
  Serial.println("\n[TEST] Direct TLS test complete");
}

void wifi() {
  const String ssid = configuredSsid();
  if (!ssid.length() || ssid == "YOUR_2_4_GHZ_WIFI") {
    setBleStatus("wifi_not_configured", "처음 한 번만 옷봉에 사용할 2.4 GHz Wi-Fi를 설정해 주세요.");
    return;
  }
  Serial.printf("[WIFI] Connecting to %s...\n", ssid.c_str());
  setBleStatus("wifi_connecting", "선택한 2.4 GHz Wi-Fi에 연결하고 있습니다. 잠시만 기다려 주세요.");
  if (connectWifi(ssid, configuredPassword())) {
    Serial.printf("[WIFI] CONNECTED IP=%s channel=%d\n", WiFi.localIP().toString().c_str(), WiFi.channel());
    setBleStatus("wifi_connected", "Wi-Fi 연결이 완료되었습니다. 서버 연결을 확인하고 있습니다.");
    syncTlsClock();
    testDirectTls();
    return;
  }
  const int failure = WiFi.status();
  const bool networkVisible = diagnoseWifi(ssid);
  if (!networkVisible) {
    setBleStatus("wifi_not_found", "선택한 2.4 GHz Wi-Fi를 찾지 못했습니다. Wi-Fi 이름·거리·2.4 GHz 설정을 확인하세요.");
  } else if (failure == WL_CONNECT_FAILED) {
    setBleStatus("wifi_password_failed", "Wi-Fi 인증에 실패했습니다. 선택한 Wi-Fi의 비밀번호를 다시 확인하세요.");
  } else {
    setBleStatus("wifi_connection_failed", "선택한 Wi-Fi에 연결하지 못했습니다. 전원과 네트워크 상태를 확인한 뒤 다시 시도하세요.");
  }
  if (!networkVisible && String(WIFI_SSID).length() && String(WIFI_SSID) != ssid && String(WIFI_SSID) != "YOUR_2_4_GHZ_WIFI") {
    Serial.printf("[WIFI] Falling back to config.h SSID: %s\n", WIFI_SSID);
    if (connectWifi(WIFI_SSID, WIFI_PASSWORD)) {
      Serial.printf("[WIFI] CONNECTED IP=%s channel=%d\n", WiFi.localIP().toString().c_str(), WiFi.channel());
      wifiPrefs.putString("ssid", WIFI_SSID);
      wifiPrefs.putString("pass", WIFI_PASSWORD);
      setBleStatus("wifi_connected", "Wi-Fi 연결이 완료되었습니다.");
      syncTlsClock();
      return;
    }
  }
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
  // ESP-NOW requires the Arduino Wi-Fi driver to be initialized even when the
  // rod has no saved SSID yet (the normal first-setup state). Previously the
  // early return in wifi() left the driver uninitialized and esp_now_init()
  // dereferenced a null internal handle, rebooting the S3 before registration.
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  configureWifiCountry();
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
  handleSerialDiagnostics();
  if (setupPortalActive) {
    setupDns.processNextRequest();
    setupServer.handleClient();
  }
  if (rebootAt && millis() >= rebootAt) ESP.restart();
  if (bleAdvertiseRestartAt && millis() >= bleAdvertiseRestartAt) {
    bleAdvertiseRestartAt = 0;
    BLEDevice::startAdvertising();
    Serial.println("[BLE] Advertising restarted after disconnect");
  }
  if (bleWifiScanRequested) {
    bleWifiScanRequested = false;
    scanNearbyWifiForBle();
  }
  uint32_t t = millis();
  static uint8_t wifiRetryCount = 0;
  if (WiFi.status() != WL_CONNECTED && t - wifiRetryAt > 5000) {
    wifiRetryAt = t;
    if (++wifiRetryCount > 3) {
      wifiRetryCount = 0;
      Serial.println("[WIFI] Re-running network discovery and fallback");
      wifi();
    } else {
      Serial.println("[WIFI] reconnecting network");
      WiFi.reconnect();
    }
  } else if (WiFi.status() == WL_CONNECTED) {
    wifiRetryCount = 0;
  }

  // 1. A physical NFC transition is the source of truth. Process exactly one
  // pending packet before command polling so PRESENT/EMPTY never waits behind
  // a slow Cloud GET request.
  sw::Packet batch[6];
  uint8_t batchCount = 0;
  sw::Packet p;
  while (batchCount < 6 && dequeue(p)) {
    if (duplicateStatus(p)) {
      Serial.printf("[ESPNOW] duplicate skipped Hanger=%s Seq=%lu\n", p.hangerId, p.sequence);
      continue;
    }
    if (p.type == sw::Type::ACK) {
      if (WiFi.status() == WL_CONNECTED) ack(p);
    } else if (p.type == sw::Type::STATUS || p.type == sw::Type::EVENT) {
      batch[batchCount++] = p;
    }
  }
  if (WiFi.status() == WL_CONNECTED && batchCount) {
    if (batchCount == 1) upload(batch[0]);
    else uploadBatch(batch, batchCount);
  }

  // 2. Cloud FIND remains frequent, but comes after the physical state event.
  if (WiFi.status() == WL_CONNECTED && t - cloudAt > COMMAND_POLL_INTERVAL_MS) {
    cloudAt = t;
    fetchCommands();
  }

  // A connected C3 must remain online even if no C6 tag packet arrived.
  if (WiFi.status() == WL_CONNECTED && t - gatewayHeartbeatAt > 8000) {
    gatewayHeartbeatAt = t;
    gatewayHeartbeat();
  }

  // 3. Beacon (every 250ms). Fast beaconing lets hangers lock channel instantly.
  if (t - beaconAt > 250) {
    beaconAt = t;
    beacon();
  }

  static uint32_t lastGwLogAt = 0;
  if (t - lastGwLogAt > 5000) {
    lastGwLogAt = t;
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[GATEWAY] WiFi channel=%d (SSID=%s IP=%s)\n", WiFi.channel(), WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
    }
  }

  delay(2);
}
