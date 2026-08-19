# PA Smart Wardrobe System - 통합 기술 규격 및 연동 가이드 (Master Spec Guide)

본 문서는 하드웨어 칩 데이터시트, 유저 매뉴얼, 실제 구매 모듈, 무선 통신 규격, 펌웨어 및 백엔드 서버 로직을 하나로 융합하여 정리한 **PA 프로젝트 단일 최종 기술 기준서(Source of Truth)**입니다.

---

## 1. 프로젝트 기준 문서 및 참조 링크

| 구분 | 기준 문서 / 레퍼런스 | 역할 및 기준 내용 | 로컬 파일 / 링크 |
|---|---|---|---|
| **NFC Controller IC** | **NXP PN532 C1 Datasheet** | 전기적 특성, 전압(`VBAT 2.7~5.5V`, `PVDD 1.6~3.6V`), I2C 인터페이스 규격 | [`datesheet/PN532_C1.pdf`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/datesheet/PN532_C1.pdf) |
| **NFC Command/Protocol** | **NXP PN532 User Manual** | 호스트 인터페이스 프레임 구조, SAMConfiguration, InListPassiveTarget 명령 | [`datesheet/PN532_USERGUIDE.pdf`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/datesheet/PN532_USERGUIDE.pdf) |
| **실제 Breakout Board** | **PN532 NFC RFID V3 모듈** | 2비트 DIP 스위치 설정(I2C: `0 1`), 온보드 3.3V LDO, 온보드 I2C 풀업 저항 | [스마트스토어 구매페이지](https://smartstore.naver.com/misoparts/products/11470443972) |
| **NFC Tag / 의류 라벨** | **NXP NTAG213/215/216 Datasheet** | ISO/IEC 14443A Type 2 Tag, 106 kbps, 7-byte UID (Cascade Level 1 & 2), 13.56 MHz | [`datesheet/NTAG213_215_216.pdf`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/datesheet/NTAG213_215_216.pdf) |
| **MCU 1 (Hanger)** | **Seeed Studio XIAO ESP32-C6** | RISC-V 160MHz, Wi-Fi 6 / BLE 5 / 802.15.4, I2C(D4/D5), 저전력 배터리 지향 | [`datesheet/Getting Started with Seeed Studio XIAO ESP32C6.md`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/datesheet/Getting%20Started%20with%20Seeed%20Studio%20XIAO%20ESP32C6.md) |
| **MCU 2 (Gateway)** | **Seeed Studio XIAO ESP32-S3** | Xtensa Dual-Core 240MHz, 2.4GHz Wi-Fi + ESP-NOW 동시 운용, USB-CDC/Serial | [`datesheet/Getting Started with Seeed Studio XIAO ESP32-S3 Series.md`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/datesheet/Getting%20Started%20with%20Seeed%20Studio%20XIAO%20ESP32-S3%20Series.md) |
| **무선 프로토콜 분석** | **ESP-IDF ESP-NOW Official Guide** | 비연결형 802.11 액션 프레임, 브로드캐스트 채널 라우팅, 채널 스윕 알고리즘 | [`datesheet/ESPNOW_OFFICIAL_VS_PA_GUIDE.md`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/datesheet/ESPNOW_OFFICIAL_VS_PA_GUIDE.md) |
| **통합 패킷 규격** | **`shared/protocol.h`** | `sw::Packet` (139B), FNV-1a 32비트 체크섬, `idCode` 압축, 패킷 타입/상태 | [`shared/protocol.h`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/shared/protocol.h) |
| **행거 펌웨어** | **`firmware/hanger/src/main.cpp`** | NFC 스캔 디바운싱, UID 추출, 상태 머신, ESP-NOW 브로드캐스트 3회 전송 | [`firmware/hanger/src/main.cpp`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/firmware/hanger/src/main.cpp) |
| **게이트웨이 펌웨어** | **`firmware/gateway/src/main.cpp`** | 링버퍼 큐, 비콘 송출(2s), HTTP POST(`/api/gateway/status`, `/ack`), 명령 폴링(1.5s) | [`firmware/gateway/src/main.cpp`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/firmware/gateway/src/main.cpp) |
| **백엔드 서버** | **`backend/server.js`** | `bootId`/`sequence` 중복 제거, `reconcile()`, 의류-옷걸이 매핑, WebSocket 브로드캐스트 | [`backend/server.js`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/backend/server.js) |

---

## 2. 하드웨어 계층 및 물리 인터페이스

### 2.1 Hanger (XIAO ESP32-C6 ↔ PN532 V3 Breakout Board)
- **통신 방식**: **I2C Interface** (Clock: 100 kHz, 7-bit Slave Address: `0x24`)
- **하드웨어 핀맵**:
  - `PIN_SDA = D4 (GPIO 22)` ↔ PN532 `SDA`
  - `PIN_SCL = D5 (GPIO 23)` ↔ PN532 `SCL`
  - `PN532_IRQ = D2 (GPIO 2)` ↔ PN532 `IRQ` (P70_IRQ)
  - `PN532_RESET = D3 (GPIO 3)` ↔ PN532 `RST` (RSTPD_N)
  - `PIN_LED = D1 (GPIO 1)` ↔ 옷걸이 인디케이터 LED
- **Breakout Board 스위치 설정**:
  - 2-Bit DIP 스위치: **`CH1 = 0 (OFF / L), CH2 = 1 (ON / H)`** (보드 실크 인쇄: `I2C: 0 1`)
- **전원 공급**:
  - XIAO C6의 `3.3V` 핀 → PN532 모듈 `VCC` (I/O 로직 레벨 3.3V 일치).

### 2.2 NFC Tag (NTAG213 / NTAG215 / NTAG216) 규격
- **표준**: ISO/IEC 14443-3 Type A, NFC Forum Type 2 Tag
- **무선 주파수 및 전송 속도**: 13.56 MHz, 106 kbit/s
- **UID 구조**:
  - **7-byte Unique Serial Number** (Page `00h`, `01h`, `02h`의 Byte 0에 영구 기록).
  - Manufacturer ID (Byte 0): NXP 전용 식별 코드 **`0x04`**.
  - Cascade Level 1: `UID0 (0x04)`, `UID1`, `UID2` + Check Byte 0 (`BCC0`).
  - Cascade Level 2: `UID3`, `UID4`, `UID5`, `UID6` + Check Byte 1 (`BCC1`).
- **상호 작용 거리**: 안테나 튜닝 기준 최대 10~50mm.

---

## 3. 엔드투엔드 데이터 흐름 및 프로토콜 변환

### 3.1 전체 데이터 파이프라인 (NFC Tag → Web UI)

```text
[1. NFC Tag (의류)]
  │  13.56 MHz RF Field (ISO/IEC 14443A)
  ▼
[2. PN532 V3 Board]
  │  I2C Standard Mode (100kHz, Addr: 0x24)
  ▼
[3. Hanger (XIAO ESP32-C6)]
  │  - scanNfc() 디바운싱: 3회 일치 시 PRESENT, 8회 연속 미감지 시 EMPTY
  │  - UID 바이너리 저장: uint8_t uid[7] (Length: 4 or 7)
  │  - 패킷 생성: sw::Packet (Type::EVENT or STATUS, 139 Bytes)
  │  - FNV-1a 체크섬 seal() 및 3회 중복 송신 (Random Jitter 18~88ms)
  │  ESP-NOW Broadcast (MAC: FF:FF:FF:FF:FF:FF, Channel: AP 동기화)
  ▼
[4. Gateway (XIAO ESP32-S3)]
  │  - receive() 콜백: 임계구역 링버퍼 queue[32]에 즉시 enqueue
  │  - loop() 메인루프: dequeue() 후 JSON 변환
  │    * uidHex() 변환: [0x04, 0xA1, 0xB2, 0xC3] -> "04A1B2C3" (HEX String)
  │  HTTP POST /api/gateway/status (Bearer Auth, Header: X-Gateway-Id)
  ▼
[5. Backend Server (server.js)]
  │  - status() 처리: bootId와 sequence를 비교하여 중복 패킷 폐기
  │  - reconcile() 실행:
  │    * tagUid를 DB(wardrobe.json)의 garments 목록과 매핑
  │    * 동일 UID 중복 거치 감지 시 CONFLICT 상태 전환
  │    * 미등록 태그 감지 시 UNKNOWN_TAG 상태 전환
  │    * 정상 매핑 시 garment.currentState = 'IN_WARDROBE'
  │  WebSocket emit('hanger.state', hanger)
  ▼
[6. Web Dashboard / App]
  실시간 옷장 현황 화면 즉시 갱신
```

### 3.2 역방향 의류 찾기 파이프라인 (Web UI → LED 점등 → ACK)

```text
[1. User (Web UI)]
  │  POST /api/garments/:id/find
  ▼
[2. Backend Server]
  │  - 의류가 위치한 hangerId 조회 ("HC-0012AB")
  │  - newCommand([hangerId]) 생성 (status: 'QUEUED', commandId: numericId)
  ▼
[3. Gateway (XIAO ESP32-S3)]
  │  - 1500ms 주기 폴링: GET /api/gateway/commands
  │  - JSON 수신 -> sw::Packet 생성 (Type::COMMAND, Command::LED_BLINK, durationMs)
  │  - sw::idCode("HC-0012AB") -> targetIds[0] 변환 (16진수 문자열 -> 32비트 정수 압축)
  │  - ESP-NOW 3회 연속 브로드캐스트 송출 (Jitter 25~75ms)
  ▼
[4. Hanger (XIAO ESP32-C6)]
  │  - receive() 콜백: sw::valid(p) 및 sw::target(p, hanger) 확인
  │  - LED 점등 타이머 구동: ledUntil = millis() + durationMs
  │  - ack(p) 생성: Type::ACK, commandId = cmd.commandId, gatewayId = cmd.gatewayId
  │  ESP-NOW Broadcast ACK 송출
  ▼
[5. Gateway]
  │  - receive() -> enqueue -> dequeue -> ack()
  │  HTTP POST /api/gateway/ack (Body: { commandId, hangerId, result: "OK" })
  ▼
[6. Backend Server]
  │  - command.acknowledgements[hangerId] = 'OK' 기록
  │  - 모든 타깃 수신 완료 시 status = 'ACKED' 갱신
  │  WebSocket emit('command.ack', c)
```

---

## 4. `shared/protocol.h` 데이터 구조 명세

```cpp
namespace sw {
  constexpr uint8_t VERSION = 1;
  constexpr uint8_t MAX_TARGETS = 16;
  constexpr uint8_t BROADCAST[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

  enum class Type : uint8_t { BEACON = 1, STATUS = 2, EVENT = 3, COMMAND = 4, ACK = 5 };
  enum class State : uint8_t { PRESENT = 1, EMPTY = 2, UNKNOWN_TAG = 4, UNSTABLE = 5 };
  enum class Command : uint8_t { LED_BLINK = 1 };

  struct __attribute__((packed)) Packet {
    uint16_t magic = 0x5753;            // 0x5753 (ASCII 'WS')
    uint8_t  version = VERSION;          // 1
    Type     type = Type::STATUS;        // 패킷 타입
    char     gatewayId[16]{};            // 게이트웨이 ID 문자열
    char     hangerId[16]{};             // 옷걸이 ID 문자열
    State    state = State::EMPTY;       // 옷걸이 거치 상태
    uint8_t  uidLength = 0;              // UID 유효 길이 (4, 7)
    uint8_t  uid[7]{};                   // NTAG UID 바이너리 배열
    uint32_t sequence = 0;               // 단조 증가 패킷 번호
    uint32_t bootId = 0;                 // 부팅 난수 세션 ID
    uint32_t commandId = 0;              // 명령 ID
    Command  command = Command::LED_BLINK;
    uint16_t durationMs = 0;             // 동작 지속 시간 (ms)
    uint8_t  targetCount = 0;            // 대상 수 (최대 16)
    uint32_t targetIds[MAX_TARGETS]{};   // 대상 ID 해시 정수 배열
    uint32_t errorFlags = 0;             // 에러 비트마스크
    char     firmware[12]{};             // 펌웨어 버전 ("1.0.0")
    uint32_t checksum = 0;               // FNV-1a 32비트 체크섬
  };
  static_assert(sizeof(Packet) <= 250, "ESP-NOW v1 packet limit"); // 139 Bytes <= 250 Bytes
}
```

---

## 5. RF 채널 자율 복구 및 동기화 전략

1. **Gateway Wi-Fi 채널 획득**: 게이트웨이는 가정용 Wi-Fi 공유기에 접속(`WiFi.begin()`)하며 공유기가 지정한 무선 채널(`WiFi.channel()`)을 자동으로 획득하여 ESP-NOW 채널로 사용.
2. **Gateway BEACON 송출**: 게이트웨이는 2000ms마다 `BEACON` 패킷을 브로드캐스트.
3. **Hanger 채널 락인**: 행거는 NVS(Flash)에 저장된 이전 채널로 부팅 후 `BEACON`을 수신하면 즉시 해당 채널을 NVS에 갱신 저장하고 비콘 타이머를 리셋.
4. **Hanger 채널 스윕 복구**: 공유기 재부팅이나 채널 변경으로 15초(`millis() - lastBeacon >= 15000`) 동안 비콘이 끊기면, 420ms(`CHANNEL_DWELL_MS`)마다 채널을 1씩 올려가며 1~13 채널을 스윕(`recoverChannel()`). 새 채널에서 비콘을 수신하는 즉시 채널이 재동기화됨.

---

## 6. 하드웨어 도착 후 최종 실측 검증 체크리스트

| 검증 ID | 대상 서브시스템 | 테스트 항목 및 조건 | 합격 판정 기준 |
|---|---|---|---|
| **HW-01** | NFC 인터페이스 | C6 부팅 시 `nfc.getFirmwareVersion()` 호출 | 반환값 `0x32` (`[NFC] READY`) |
| **HW-02** | NTAG213 인식 | NTAG213 스티커 태그 안테나 접촉 | 7-byte UID 정확 인식 및 `PRESENT` 전이 |
| **HW-03** | 태그 이탈 감지 | 의류 분리 시 8회 연속 미감지 누적 (약 1.76초) | `EMPTY` 전이 및 `EVENT` 패킷 방출 |
| **HW-04** | 무선 통신 거리 | 옷장 문 닫힘 및 옷 10벌 밀집 상태에서 5m 통신 | 패킷 수신율 99% 이상 |
| **HW-05** | 다수 옷걸이 간섭 | 옷걸이 5대가 동시에 상태 변경 발생 | 랜덤 Jitter(18~88ms)로 충돌 없이 수신 |
| **HW-06** | 채널 자동 복구 | 공유기 채널 강제 변경 (Ch 1 → Ch 11) | 행거가 15초 후 5초 이내 새 채널 자동 락인 |
| **HW-07** | LED 찾기 명령 | 웹에서 "옷 찾기" 클릭 | 게이트웨이 폴링 후 행거 LED 점등 및 ACK 수신 |

---

## 7. 추가 데이터시트 및 가이드 필요 여부 최종 점검

현재 PA 스마트 옷장 프로젝트를 완벽히 구축하고 펌웨어/소프트웨어를 연동하는 데 필요한 모든 핵심 부품의 데이터시트 및 가이드가 구비되었습니다:

1. **메인 MCU 2종**: Seeed Studio XIAO ESP32-C6 & XIAO ESP32-S3 기술 가이드 완비.
2. **NFC 서브시스템**: NXP PN532 IC 데이터시트, 유저 매뉴얼, Breakout Board 하드웨어 스펙, NTAG213/215/216 태그 규격 완비.
3. **무선 통신**: Espressif ESP-IDF ESP-NOW 공식 API 및 Example 아키텍처 비교 분석 완비.
4. **소프트웨어 스펙**: `shared/protocol.h`, 펌웨어 상태 머신, 백엔드 REST/WebSocket API 및 Reconcile 로직 완비.

추가적인 외부 데이터시트나 기술 문서는 더 이상 필요하지 않으며, 현재 준비된 자료만으로 실물 하드웨어 도착 즉시 조립, 펌웨어 빌드/업로드 및 실측 테스트를 완벽하게 수행할 수 있습니다.
