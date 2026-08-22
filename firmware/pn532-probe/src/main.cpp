#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_PN532.h>

constexpr uint8_t PIN_SDA = D4;
constexpr uint8_t PIN_SCL = D5;
constexpr uint8_t PN532_IRQ = D2;
constexpr uint8_t PN532_RESET = D3;

Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET, &Wire);
bool probeReady = false;

constexpr uint8_t PN532_I2C_ADDR = 0x24;

bool waitIrq(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (digitalRead(PN532_IRQ) != LOW) {
    if (millis() - start >= timeoutMs) return false;
    delay(1);
  }
  return true;
}

bool writeInListCommand() {
  // PN532 I2C host frame: preamble, start codes, length/checksum,
  // TFI=D4, InListPassiveTarget=4A, max one target, ISO14443A (00).
  const uint8_t frame[] = {0x00, 0x00, 0xFF, 0x04, 0xFC,
                           0xD4, 0x4A, 0x01, 0x00, 0xE1, 0x00};
  Wire.beginTransmission(PN532_I2C_ADDR);
  Wire.write(frame, sizeof(frame));
  const uint8_t status = Wire.endTransmission();
  if (status != 0) Serial.printf("[DIRECT] I2C write status=%u\n", status);
  return status == 0;
}

uint8_t readI2C(uint8_t* out, uint8_t count) {
  const uint8_t received = Wire.requestFrom(PN532_I2C_ADDR, (uint8_t)(count + 1));
  if (received < count + 1) return 0;
  Wire.read(); // I2C RDY byte; IRQ already told us the frame is ready.
  for (uint8_t i = 0; i < count; ++i) out[i] = Wire.read();
  return count;
}

bool directScan(uint8_t* uid, uint8_t& uidLen) {
  if (!writeInListCommand()) return false;
  if (!waitIrq(1200)) {
    Serial.printf("[DIRECT] ACK wait timeout irq=%d\n", digitalRead(PN532_IRQ));
    return false;
  }

  uint8_t ack[6] = {0};
  if (readI2C(ack, sizeof(ack)) == 0) return false;
  if (!(ack[0] == 0x00 && ack[1] == 0x00 && ack[2] == 0xFF &&
        ack[3] == 0x00 && ack[4] == 0xFF && ack[5] == 0x00)) {
    Serial.printf("[DIRECT] bad ACK %02X %02X %02X %02X %02X %02X\n",
                  ack[0], ack[1], ack[2], ack[3], ack[4], ack[5]);
    return false;
  }

  if (!waitIrq(1200)) {
    Serial.printf("[DIRECT] response wait timeout irq=%d\n", digitalRead(PN532_IRQ));
    return false;
  }
  uint8_t response[20] = {0};
  if (readI2C(response, sizeof(response)) == 0) return false;
  // Response frame: 00 00 FF LEN LCS D5 4B NbTg ... NFCIDLen UID...
  if (response[0] != 0x00 || response[1] != 0x00 || response[2] != 0xFF ||
      response[5] != 0xD5 || response[6] != 0x4B || response[7] != 0x01) {
    Serial.printf("[DIRECT] bad response %02X %02X %02X %02X %02X %02X %02X %02X\n",
                  response[0], response[1], response[2], response[3], response[4],
                  response[5], response[6], response[7]);
    return false;
  }
  uidLen = response[12];
  if (uidLen == 0 || uidLen > 7) return false;
  memcpy(uid, response + 13, uidLen);
  return true;
}

void printUid(const uint8_t* uid, uint8_t len) {
  Serial.print("[PROBE] UID=");
  for (uint8_t i = 0; i < len; ++i) {
    if (uid[i] < 0x10) Serial.print('0');
    Serial.print(uid[i], HEX);
  }
  Serial.printf(" len=%u\n", len);
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  pinMode(PN532_IRQ, INPUT);
  nfc.begin();
  const uint32_t version = nfc.getFirmwareVersion();
  Serial.printf("[PROBE] firmware=%08lX\n", version);
  if (!version) return;
  if (!nfc.SAMConfig()) {
    Serial.println("[PROBE] SAM FAIL");
    return;
  }
  if (!nfc.setPassiveActivationRetries(0x01)) {
    Serial.println("[PROBE] RF CONFIG FAIL");
    return;
  }
  probeReady = true;
  Serial.printf("[PROBE] READY; irq=%d; hold tag on antenna\n", digitalRead(PN532_IRQ));
}

void loop() {
  if (!probeReady) {
    delay(1000);
    return;
  }
  static uint32_t lastPoll = 0;
  if (millis() - lastPoll < 1200) return;
  lastPoll = millis();
  uint8_t uid[7] = {0};
  uint8_t len = 0;
  if (directScan(uid, len) && len > 0 && len <= 7) {
    printUid(uid, len);
  } else {
    Serial.println("[PROBE] NO UID");
  }
}
