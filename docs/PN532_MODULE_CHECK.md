# PN532 module check

Verify the actual board's mode switches/jumpers select I2C. Confirm its accepted VCC range and pullups from the vendor marking/manual. Run an I2C scan, then read and normalize a 7-byte NTAG213 UID. Do not infer compatibility from PCB color. `REQUIRES_PHYSICAL_TEST`.
