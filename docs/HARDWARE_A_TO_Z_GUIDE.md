# Hardware A-to-Z build guide

1. Inventory BOM; inspect PN532 selector and its voltage label.
2. Build the C6/PN532/LED circuit on a bench. Verify no VCC-GND short; then flash and read an NTAG213.
3. Add capacitor with correct polarity. Confirm 5 V at the board input while LED is on.
4. Print/fit PN532, C6, LED, wire and pogo holders; keep NFC antenna away from magnet/steel/rod.
5. Build rod: Kapton completely isolates rod; apply continuous +5 V copper above it; fit steel strip for rotational alignment; fit fuse upstream.
6. Fit parallel positive pogos and ground hook/contact. Use the magnet only to restore rotation, never as a slot or X-position lock.
7. Test empty, shirt, trousers and coat for free lateral movement and reliable contact.

Expected bench supply is nominal 5 V; record the actual measured voltage/current. If any step fails, disconnect power, inspect polarity/continuity, then retest. All values and mechanics need `REQUIRES_PHYSICAL_TEST`.
