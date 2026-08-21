# Wiring

1. With power disconnected, set PN532 to I2C mode.
2. Connect black wire: C6 GND -> PN532 GND. Connect SDA and SCL using the pin map; connect VCC only after confirming PN532 voltage requirements.
3. Connect D1 through 330 ohm to LED anode; LED cathode to GND.
4. Join both pogo positive contacts in parallel to +5 V. The rod/hook ground contact goes to GND; do not join it to positive pogo.
5. Place 100 uF capacitor at input: marked `+` to +5 V, `-` to GND.

Continuity-test before power. Never use the rod as +5 V and GND simultaneously. `REQUIRES_PHYSICAL_TEST`.
