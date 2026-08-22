#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

// This is a temporary, standalone radio diagnostic. It does not connect to
// Wi-Fi, BLE, ESP-NOW, PN532, or the dashboard.
constexpr char TARGET_SSID[] = "Gaon303_2.5G";

void scanPass(uint8_t pass) {
  bool targetFound = false;
  Serial.printf("\n[PROBE] pass %u/5\n", pass);
  for (uint8_t channel = 1; channel <= 13; ++channel) {
    WiFi.scanDelete();
    const int count = WiFi.scanNetworks(false, true, true, 1000, channel);
    Serial.printf("[PROBE] channel=%u count=%d\n", channel, count);
    for (int i = 0; i < count; ++i) {
      const String ssid = WiFi.SSID(i);
      if (ssid != TARGET_SSID) continue;
      targetFound = true;
      Serial.printf("[PASS] target=%s channel=%d rssi=%d\n", TARGET_SSID, WiFi.channel(i), WiFi.RSSI(i));
    }
  }
  Serial.printf(targetFound ? "[PROBE] PASS: target was received\n" : "[PROBE] MISS: target was not received\n");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);
  Serial.printf("[PROBE] standalone Wi-Fi scan, target=%s\n", TARGET_SSID);
}

void loop() {
  for (uint8_t pass = 1; pass <= 5; ++pass) scanPass(pass);
  Serial.println("[PROBE] cycle complete; repeating in 5 seconds");
  delay(5000);
}
