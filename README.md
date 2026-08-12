# Smart Wardrobe ESP-NOW Service

NTAG213 → PN532 → XIAO ESP32-C6 → ESP-NOW → XIAO ESP32-S3 → Web/PWA 전체 경로를 위한 프로젝트입니다.

처음 시작한다면 **[docs/00_MASTER_START_TO_FINISH_GUIDE.md](docs/00_MASTER_START_TO_FINISH_GUIDE.md)** 하나를 위에서부터 순서대로 따라가세요. 소프트웨어 빠른 실행은 `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1` 후 `npm start`입니다.

실물 장치, NFC 거리, Pogo 접점, 전원 용량, RF/채널 복구 및 공개 URL은 장비 없이는 완료로 표시할 수 없으며 문서에서 `REQUIRES_PHYSICAL_TEST`로 구분합니다.
