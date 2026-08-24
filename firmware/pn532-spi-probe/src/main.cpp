#include <Arduino.h>
#include <SPI.h>
#include <Adafruit_PN532.h>

// XIAO ESP32-C6 hardware SPI pins.
constexpr uint8_t PIN_SCK = D8;   // GPIO19
constexpr uint8_t PIN_MISO = D9;  // GPIO20
constexpr uint8_t PIN_MOSI = D10; // GPIO18
constexpr uint8_t PIN_SS = D6;    // GPIO16

constexpr uint8_t EXPECTED_UID[] = {0x04, 0x52, 0x9E, 0x02, 0x6F, 0x24, 0x90};

Adafruit_PN532 nfc(PIN_SS, &SPI);

void printUid(const uint8_t *uid, const uint8_t uidLength) {
  for (uint8_t i = 0; i < uidLength; ++i) {
    if (uid[i] < 0x10) Serial.print('0');
    Serial.print(uid[i], HEX);
  }
}

bool isExpectedTag(const uint8_t *uid, const uint8_t uidLength) {
  return uidLength == sizeof(EXPECTED_UID) &&
         memcmp(uid, EXPECTED_UID, sizeof(EXPECTED_UID)) == 0;
}

void setup() {
  Serial.begin(115200);
  delay(800);

  Serial.println("\n[PN532-SPI] NTAG213 raw UID probe starting");
  Serial.printf("[PN532-SPI] SCK=D8/GPIO%d MISO=D9/GPIO%d MOSI=D10/GPIO%d SS=D6/GPIO%d\n",
                PIN_SCK, PIN_MISO, PIN_MOSI, PIN_SS);

  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_SS);
  nfc.begin();

  const uint32_t version = nfc.getFirmwareVersion();
  if (version == 0) {
    Serial.println("[FAIL] PN532 firmware not found. Check SPI wiring, SS, and DIP mode.");
    return;
  }

  Serial.printf("[OK] PN532 firmware=0x%08lX\n", static_cast<unsigned long>(version));
  nfc.SAMConfig();
  // NTAG213's small garment antenna can need more than one polling attempt.
  // Keep the PN532 field polling at its supported maximum for this diagnostic.
  nfc.setPassiveActivationRetries(0xFF);
  Serial.println("[READY] Hold the NTAG213 directly on the PN532 antenna.");
}

void loop() {
  static uint32_t lastNoTagLog = 0;
  uint8_t uid[7] = {};
  uint8_t uidLength = 0;

  const bool found = nfc.readPassiveTargetID(
      PN532_MIFARE_ISO14443A, uid, &uidLength, 500);

  if (found) {
    Serial.print("[TAG] UID=");
    printUid(uid, uidLength);
    Serial.println();
    Serial.println(isExpectedTag(uid, uidLength)
                       ? "[PASS] Expected NTAG213 (04529E026F2490) detected"
                       : "[OK] A different ISO14443A tag was detected");
    delay(700);
    return;
  }

  if (millis() - lastNoTagLog >= 1500) {
    Serial.println("[WAIT] No tag detected yet");
    lastNoTagLog = millis();
  }
}
