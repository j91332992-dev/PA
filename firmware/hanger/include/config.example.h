#pragma once
#define NFC_SCAN_INTERVAL_MS 70
#define PRESENT_CONFIRM_COUNT 1
#define REMOVE_GRACE_MS 220
#define HEARTBEAT_MIN_MS 1000
// Spread multiple hangers over a small window so they do not all transmit on
// the same millisecond when the wardrobe power is switched on together.
#define HEARTBEAT_JITTER_MS 200
#define CHANNEL_DWELL_MS 2500
#define LED_ACTIVE_HIGH 1
