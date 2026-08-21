# Software A-to-Z guide

Install Node 20+ and PlatformIO. Copy `.env.example` to `.env`, set a unique `JWT_SECRET` and `DEVICE_TOKEN`, then run `npm install`, `npm start`, and open `http://localhost:8787`. Run `npm run simulator -- 50` in another shell (same `DEVICE_TOKEN`) to load synthetic hangers. Run `npm test` for the included contract check.

For firmware, open each `firmware/*` project in PlatformIO, confirm board/PN532 pinout, build, flash by USB and inspect serial logs. The firmware is a foundation and has intentionally marked hardware-driver/TLS/MQTT integrations pending physical and deployment configuration.
