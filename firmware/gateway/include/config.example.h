#pragma once
#define WIFI_SSID "YOUR_2_4_GHZ_WIFI"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define CLOUD_BASE_URL "https://your-smart-wardrobe-api.example.com"
#define DEVICE_TOKEN "SAME_VALUE_AS_SERVER_ENV"
// Required only when CLOUD_BASE_URL (or the saved BLE server address) is HTTPS.
// Paste the public PEM root certificate that signs the deployed server's chain.
// This is not a password or device secret.
#define CLOUD_TLS_ROOT_CA ""
// Keep 1 only while using a local development HTTP server. Public deployments
// must use HTTPS and set this to 0 before firmware is distributed.
#define ALLOW_INSECURE_HTTP 0
