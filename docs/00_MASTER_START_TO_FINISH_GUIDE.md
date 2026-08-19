# 처음부터 끝까지 마스터 가이드

이 문서는 전자·펌웨어·서버 경험이 없는 사용자도 한 단계씩 확인하며 완성하도록 작성되었습니다. 단계를 건너뛰지 마세요.

## 0. 완성되는 흐름

옷의 NTAG213 UID를 PN532가 읽고, C6 옷걸이가 상태를 ESP-NOW로 S3 게이트웨이에 보냅니다. S3는 2.4 GHz Wi-Fi로 서버 API를 호출하고 PWA가 WebSocket으로 갱신됩니다. 화면의 `LED 찾기`는 반대 경로로 내려가며 옷걸이가 ACK를 반환합니다.

## 1. 필요한 부품과 공구

첫 1대 검증용: XIAO ESP32-C6, XIAO ESP32-S3, red PCB PN532 V3-style, NTAG213, LED, 330 Ω 저항, 100 µF 16 V 전해 커패시터, 점퍼선, 브레드보드, 데이터 USB-C 케이블 2개. 전원 기구용: 금속 원형 봉, Kapton, 동박, 자성 철판 스트립, 2개 +5 V pogo, GND 접점/금속 Hook, 퓨즈 홀더, 5 V/3 A 충전기. 공구: 멀티미터, 인두, 납, 수축튜브, 니퍼, 절연장갑/보안경.

첫 시험은 봉을 만들기 전에 USB/브레드보드로 합니다. 퓨즈 정격과 50대 전원은 실측 뒤 정합니다. `REQUIRES_PHYSICAL_TEST`.

## 2. Windows 개발환경

1. Node.js 20 이상, Python 3.11 이상, Git, VS Code를 설치합니다.
2. PowerShell에서 프로젝트 폴더로 이동합니다.
3. `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -InstallPlatformIO`를 실행합니다.
4. `.env.example`을 복사해 생성된 `.env`를 엽니다. `JWT_SECRET`, `DEVICE_TOKEN`을 서로 다른 64자 이상 랜덤 문자열로 바꿉니다. Wi-Fi 비밀번호와 토큰을 Git에 올리지 않습니다.
5. `npm test`를 실행해 실패 0을 확인합니다.

실패 시: `node --version`, `python --version`, `python -m platformio --version`을 확인합니다. PowerShell 스크립트 차단은 위 명령처럼 `-ExecutionPolicy Bypass`를 해당 실행에만 사용합니다.

## 3. 서버/PWA 먼저 확인

1. `npm start`를 실행합니다. `[BOOT] Smart Wardrobe http://localhost:8787`가 정상입니다.
2. 브라우저에서 `http://localhost:8787`을 엽니다.
3. 최초 관리자 이메일과 10자 이상 비밀번호를 만듭니다.
4. 새 터미널에서 `.env`의 DEVICE_TOKEN과 같은 값을 환경 변수로 정한 뒤 `npm run simulator -- 5`를 실행합니다.
5. 대시보드에 5개 옷걸이가 나타나면 서버·API·WebSocket 경로가 정상입니다.
6. `npm run test:scale`로 50대×5회 요청의 실패 수가 0인지 확인합니다.

## 4. PN532 모듈 실물 확인

PN532 빨간 보드는 복제품별 전압/스위치 표기가 다릅니다. 보드 뒷면의 I2C 모드 표를 사진으로 기록하고 그 표대로 I2C를 선택합니다. VCC에 `3.3V/5V` 표기가 없으면 판매 페이지/회로도를 확인하기 전 연결하지 마세요. 본 프로젝트는 안전을 위해 PN532 VCC를 C6 `3V3`에서 시작하도록 권장하지만 실물 모듈이 3.3 V I2C를 지원하는지 반드시 확인합니다. `REQUIRES_PHYSICAL_TEST`.

## 5. C6 브레드보드 배선

전원을 분리한 상태에서 연결합니다.

| PN532/LED | XIAO C6 | 권장 선색 |
|---|---|---|
| PN532 SDA | D4 = GPIO22 | 파랑 |
| PN532 SCL | D5 = GPIO23 | 노랑 |
| PN532 IRQ | D2 = GPIO2 | 보라 |
| PN532 RSTO | D3 = GPIO21 | 회색 |
| PN532 GND | GND | 검정 |
| PN532 VCC | 3V3, 실물 사양 확인 후 | 빨강 |
| LED anode | D1 = GPIO1에서 330 Ω 직렬 | 주황 |
| LED cathode | GND | 검정 |

멀티미터 저항/연속 모드에서 VCC-GND가 단락이 아닌지 확인합니다. 커패시터 `+`는 5 V, 줄무늬 `-`는 GND입니다. 극성을 거꾸로 연결하지 마세요.

## 6. C6 펌웨어 빌드/업로드

1. `firmware/hanger/include/config.example.h`를 `config.h`로 복사합니다.
2. XIAO C6를 데이터 USB 케이블로 연결하고 장치 관리자에서 COM 번호를 찾습니다.
3. `powershell -File scripts/flash-hanger.ps1 -Port COM5`처럼 실제 포트를 넣습니다.
4. `cd firmware/hanger` 후 `python -m platformio device monitor -b 115200`로 로그를 봅니다.
5. `[NFC] READY`, `[BOOT] HC-xxxxxx`가 정상입니다. 태그를 3회 이상 안정적으로 읽으면 PRESENT, 제거 후 연속 미검출이면 EMPTY 이벤트가 나옵니다.

`[NFC] FAILED`: I2C 모드, 3.3 V, GND, D4/D5, IRQ/RST를 확인합니다. 업로드 실패: BOOT를 누른 채 USB 연결 후 다시 시도합니다. `REQUIRES_PHYSICAL_TEST`.

## 7. S3 게이트웨이 설정/업로드

1. `firmware/gateway/include/config.example.h`를 `config.h`로 복사합니다.
2. `WIFI_SSID`는 2.4 GHz SSID, `WIFI_PASSWORD`는 실제 비밀번호를 입력합니다.
3. 같은 LAN의 PC IP를 `ipconfig`로 확인합니다. `CLOUD_BASE_URL`을 예: `http://192.168.0.15:8787`로 지정합니다. `localhost`는 S3 자신이므로 사용하면 안 됩니다.
4. `DEVICE_TOKEN`은 서버 `.env`와 정확히 같게 합니다.
5. Windows 방화벽에서 TCP 8787 인바운드를 개인 네트워크에만 허용합니다.
6. `powershell -File scripts/flash-gateway.ps1 -Port COM6`를 실행하고 115200 모니터를 엽니다.
7. `[WIFI] IP=... channel=...`, `[BOOT] GW-xxxxxx`가 정상입니다.

## 8. 첫 ESP-NOW End-to-End 시험

1. 서버, S3, C6를 모두 켭니다.
2. C6에 태그를 가까이 댑니다.
3. C6 로그 EVENT → S3 로그 CLOUD OK → 웹 UNKNOWN_TAG 순서가 보여야 합니다.
4. 웹 `새 옷 등록`에서 화면에 보인 UID와 옷 정보를 입력합니다.
5. 다음 상태 수신부터 PRESENT/IN_WARDROBE가 됩니다.
6. `LED 찾기`를 누릅니다. 서버 QUEUED → S3 COMMAND → C6 LED → ACKED가 정상입니다.

이 시험은 실제 장치가 필요합니다. `REQUIRES_PHYSICAL_TEST`.

## 9. 옷걸이 기구 제작

PN532 안테나는 목/어깨 상단에서 태그와 평행하게 둡니다. 자석·금속봉·철판과 최대한 떨어뜨립니다. C6 USB, 상태 LED, 배선 점검이 가능한 커버를 만듭니다. 전자부를 에폭시로 영구 고정하기 전에 브레드보드→임시 고정→24시간 시험 순서로 확인합니다.

두 pogo는 모두 같은 +5 V에 병렬 연결합니다. GND는 금속 Hook 또는 별도 접점으로 금속봉에 연결합니다. +5 V pogo 중 하나를 GND로 사용하면 PRD 구조와 다르고 단락 위험이 있습니다.

## 10. 원형 옷봉 제작

1. 전원을 완전히 분리합니다.
2. 봉 표면을 세척합니다.
3. +5 V 동박이 닿는 모든 범위를 Kapton으로 완전히 절연합니다.
4. 그 위에 연속 동박을 붙입니다. 위치별 슬롯/패드를 만들지 않습니다.
5. 자성 철판 스트립은 회전 정렬용이며 동박과 전기적으로 닿지 않게 합니다.
6. 5 V 입력의 `+`는 퓨즈를 거쳐 동박, `-`는 금속봉에 연결합니다.
7. 무전원 상태에서 동박-봉 사이 연속음이 나지 않아야 합니다.
8. 전원을 넣고 동박-봉 사이 전압이 약 5 V인지 확인합니다.

단락/발열/냄새가 나면 즉시 전원을 분리합니다. `REQUIRES_PHYSICAL_TEST`.

## 11. Pogo·자석·좌우 이동 조정

빈 옷걸이, 셔츠, 바지, 코트 순으로 시험합니다. 모든 X 위치에서 전압을 기록하고 천천히/빠르게 밀 때 재부팅 로그가 없어야 합니다. 자석은 회전을 복원할 만큼만 강하게 하고 좌우 이동을 방해하면 간격을 늘립니다. NFC 인식률과 자석 거리를 함께 기록합니다. `REQUIRES_PHYSICAL_TEST`.

## 12. 공개 배포

V1 실제 서비스에는 HTTPS Node 호스트와 영구 DB가 필요합니다. 단일 인스턴스 프로토타입은 이 JSON 저장소로 가능하지만 다중 인스턴스는 PostgreSQL 어댑터로 교체하세요. 호스트 비밀 변수에 `.env` 항목을 넣고 HTTPS/WSS 도메인을 발급합니다. S3 `CLOUD_BASE_URL`을 HTTPS 주소로 바꾸고 인증서 검증을 사용합니다. 휴대폰 Wi-Fi를 끄고 LTE에서 로그인/실시간 상태/Find를 검증합니다. `REQUIRES_PHYSICAL_TEST`.

## 13. 1→3→5→10→50 확대

각 단계에서 패킷 손실, 이벤트 지연, OFFLINE 오탐, ACK 성공률, 채널 복구, 시작/끝 전압, 한 대 최대 전류를 기록합니다. 5 V/3 A는 3~5대 초기용입니다. 최종 전류는 `한 대 worst-case × 수량 + gateway + margin`으로 산정하고 필요하면 다중 전원 주입/구역화를 합니다. 실제 50대 최종 시험 전까지 `REQUIRES_PHYSICAL_TEST`입니다.

## 14. 완료 판정

소프트웨어 테스트 통과만으로 제품 완료라고 하지 않습니다. `docs/TEST_CHECKLIST.md`의 증거(측정값, 로그, 사진, 펌웨어/서버 버전)를 채운 뒤 항목별로 승인합니다.

## Windows 한글 사용자 경로 주의

PlatformIO/pioarduino 도구가 한글 사용자 경로에서 compiler path/CP949 오류를 낼 수 있습니다. 이 경우 C:\pio 같은 영문 전용 폴더에 프로젝트를 복사하고, PLATFORMIO_CORE_DIR=C:\pio-core, PYTHONUTF8=1을 설정해 빌드하세요. 본 개발 PC에서도 이 도구환경 문제가 확인되어 펌웨어 컴파일 완료 여부는 REQUIRES_PHYSICAL_TEST와 별도로 REQUIRES_ASCII_PATH_BUILD입니다.

