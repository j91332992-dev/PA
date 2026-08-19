# PA Smart Wardrobe — Physical Hardware Integration Plan (10 Stages)

본 문서는 **실제 하드웨어 부품(Seeed Studio XIAO ESP32-C6, XIAO ESP32-S3, PN532 NFC Reader 모듈, NTAG213 스티커, 파워 레일 옷봉, LED)** 도착 시, **Virtual Hardware 시뮬레이터를 100% Real Hardware로 무결점 교체하기 위한 단계별 실행 계획**입니다.

---

## 1. 하드웨어 검증 철학 및 격리 원칙 (Verification Principles)

1. **Failure Isolation (단계별 결함 격리)**:
   - 모든 하드웨어를 한 번에 연결하고 테스트하지 않습니다.
   - 단일 센서(Stage 1)부터 시작하여 I2C → 패킷 직렬화 → 무선 RF → 게이트웨이 HTTP → 백엔드 Reconcile → 클라이언트 UI → LED 점등까지 10단계로 결함을 격리 검증합니다.
2. **소프트웨어 불변성 (Software Invariance)**:
   - 백엔드 서버(`backend/server.js`), 데이터베이스, WebSocket 계약, 클라이언트 UI는 이미 시뮬레이터로 100% 검증 완료되었습니다.
   - 하드웨어 교체 시 백엔드 프로토콜을 변경하지 않고, 펌웨어(`firmware/hanger`, `firmware/gateway`)의 설정값(`config.h`)만 실제 환경에 맞춥니다.
3. **REQUIRES_PHYSICAL_TEST 태그**:
   - 각 단계마다 실제 물리 벤치에서만 측정 가능한 항목을 명확히 명시합니다.

---

## 2. 10단계 연동 로드맵 (10-Stage Integration Roadmap)

```text
[Stage 1: NFC 태그 & PN532 단독 검증]
       │ NTAG213 14자리 HEX 판독
       ▼
[Stage 2: PN532 ↔ ESP32-C6 I2C 통신]
       │ I2C Address 0x24, IRQ 인터럽트
       ▼
[Stage 3: C6 펌웨어 패킷 패킹 & protocol.h 검증]
       │ sizeof(sw::Packet) == 139 bytes
       ▼
[Stage 4: C6 ↔ S3 ESP-NOW 2.4GHz 무선 링크]
       │ 동일 Wi-Fi 채널(Channel 6), 브로드캐스트
       ▼
[Stage 5: S3 Gateway ↔ Backend HTTP 업로드]
       │ POST /api/gateway/status, X-Gateway-Id
       ▼
[Stage 6: 백엔드 상태 확정 (PRESENT / IN_WARDROBE)]
       │ Reconcile Engine, wardrobe.json 영속화
       ▼
[Stage 7: Web / Mobile 앱 실시간 이벤트 스트리밍]
       │ WebSocket emit('hanger.state'), UI 실시간 반영
       ▼
[Stage 8: 의류 찾기 (FIND) → S3 → C6 실물 LED 점멸]
       │ POST /api/commands -> S3 -> C6 -> LED ON (5분 Safety)
       ▼
[Stage 9: 실물 C6 Application ACK 응답]
       │ C6 -> S3 -> POST /api/gateway/ack -> status: ACKED
       ▼
[Stage 10: 오프라인 / 파워 레일 탈착 / RF 복구 복원력]
       │ 30초 OFFLINE 타임아웃, 옷봉 탈착, 전원 복구
```

---

## 3. 단계별 세부 실행 및 PASS 기준 (Stage Details)

### Stage 1. NTAG213 → PN532 UID Reading 및 물리 감지 거리 검증

> ⚠️ **중요**: 아래 수치는 최종 불변 사양이 아니며, **1차 3D CAD/기구 Prototype 설계의 시작 목표이자 실물 벤치 검증 범위**입니다.

#### 1) Initial Mechanical Target (1차 기구 설계 목표)
- **목표 거리**: NTAG213 스티커와 PN532 안테나 사이 간격은 **약 1cm 전후**를 1차 기구 설계 기준으로 삼습니다.
- **안정 감지 영역 (Target Sensing Range)**: **약 0.5cm ~ 2.0cm**
- **인접 간섭 한계 (Cross-Talk Threshold)**: **2.0cm ~ 3.0cm 이상**에서는 옷장에 인접해 걸린 다른 옷의 NFC Tag까지 잘못 인식(Cross-Talk)될 가능성이 있으므로 전파 범위를 기구적으로 제한해야 합니다.
- **공식 사양 vs PA Hanger의 목표**:
  - PN532의 공식 최대 통신거리(~5cm)와 PA Hanger의 실사용 감지거리를 동일시하지 않습니다.
  - PA 스마트 옷장에서는 "긴 감지거리"보다 **"현재 옷걸이에 실제로 걸린 단 1벌의 옷만 확실히 식별하는 공간적 선택성(Spatial Selectivity)"**이 절대적으로 중요합니다.

#### 2) Physical Test Matrix (실측 매트릭스)
실제 PN532 및 NTAG213 부품 수령 후, 다음 정밀 거리 단계에서 20회 반복 리딩을 수행하여 성공률을 기록합니다:

| 측정 거리 | 리딩 성공률 (PASS Criteria) | 목표 판정 | 비고 |
|---|:---:|:---:|---|
| **0.5 cm** | 100% (20/20) | **PASS (필수)** | 초근접 안정 영역 |
| **1.0 cm** | 100% (20/20) | **PASS (기본 목표)** | 1차 기구물 기준 장착 거리 |
| **1.5 cm** | > 95% (19/20) | **PASS (허용 마진)** | 두꺼운 원단/여유 공간 |
| **2.0 cm** | > 90% (18/20) | **PASS (경계 한계)** | 최대 허용 유효 거리 |
| **2.5 cm** | 감소 구간 관찰 | **관찰 (Dropoff)** | 신호 감쇄 시작 |
| **3.0 cm** | < 10% (오인식 차단) | **차단 (Cutoff)** | 인접 옷 태그 오인식 방지 영역 |
| **4.0 cm** | 0% (완전 미인식) | **차단 (Zero Signal)** | 크로스토크 완전 차단 |
| **5.0 cm** | 0% (완전 미인식) | **차단 (Zero Signal)** | 크로스토크 완전 차단 |

#### 3) Additional Robustness & Interference Tests (추가 환경 검증)
1. **옷감 원단 삽입 테스트**: 면(Cotton), 울(Wool), 합성섬유(Polyester) 원단을 PN532와 Tag 사이에 삽입하여 인식률 감쇄 여부 측정.
2. **Tag 앞/뒤 방향(Facing) 테스트**: NTAG213의 인쇄면 및 점착면 방향에 따른 수신 감도 차이 확인.
3. **Tag 기울임(Tilt & Angle) 테스트**: 거치 시 태그가 0° ~ 45° 각도로 기울어졌을 때의 판독 신뢰도 측정.
4. **의류 두께 변화 테스트**: 얇은 여름 셔츠(1~2mm)부터 두꺼운 겨울 코트/패딩(10~15mm) 거치 시의 인식 안정성.
5. **인접 Hanger 2차 태그 배치 (Cross-Talk Test)**: 옆 옷걸이(5~7cm 간격)에 걸린 다른 의류의 NTAG213을 배치하고 동시 스캔.
6. **오인식 최소 거리 측정**: 옆 옷걸이 태그가 잘못 읽히는 최소 임계 거리를 실측하여 Hanger 간 최소 이격 거리 및 차폐재(Ferrite Sheet 등) 필요성 도출.
7. **최종 PN532 장착 위치 결정**: 상기 1~6 실측 데이터를 기반으로 3D 프린팅 옷걸이 하우징 내부의 안테나 배치 각도 및 깊이를 확정.

#### 4) PASS Goal (최종 합격 기준)
- **현재 Hanger에 걸린 옷의 Tag**: 0.5~2cm 범위 내에서 100% 안정적으로 반복 판독.
- **인접 Hanger의 Tag**: 3cm 이상 거리에서 0% 미인식 (오인식 완전 배제).
- *모든 수치는 실제 물리 벤치에서 실측 완료 후 확정되며, 실측 전까지는 `REQUIRES_PHYSICAL_TEST`로 관리합니다.*

- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 2. PN532 → XIAO ESP32-C6 I2C 통신 검증
- **테스트 내용**: XIAO ESP32-C6의 `D4 (SDA / GPIO22)`, `D5 (SCL / GPIO23)` 핀을 통한 I2C 통신 및 IRQ 인터럽트 동작 확인.
- **테스트 방법**: `firmware/hanger`의 I2C 스캐너 및 PN532 초기화 루틴 실행.
- **PASS 기준**:
  - I2C 버스 스캔 시 PN532 주소 `0x24` 정상 감지.
  - `nfc.begin()` 및 `nfc.SAMConfig()` 성공.
- **결함 격리**:
  - I2C 통신 실패 시: 4.7kΩ 풀업 저항 여부 확인, SDA/SCL 교차 결선 점검.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 3. C6 패킷 직렬화 & protocol.h 바이너리 일치 검증
- **테스트 내용**: C6에서 생성된 `sw::Packet` 구조체가 `shared/protocol.h`의 139바이트 패킹 규칙과 정확히 일치하는지 확인.
- **테스트 방법**: `sizeof(sw::Packet)` 및 바이트 오프셋 Serial 출력.
- **PASS 기준**:
  - `sizeof(sw::Packet) == 139` 확인 (`sizeof(sw::Packet) <= 250` 만족).
  - 매 패킷 전송 시마다 `sequence` 번호가 1씩 단조 증가.
  - 부팅 시 생성된 `bootId`가 재부팅 전까지 유지됨.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 4. C6 → S3 실제 ESP-NOW 2.4GHz 무선 통신 검증
- **테스트 내용**: C6 옷걸이와 S3 게이트웨이 간의 2.4GHz ESP-NOW 브로드캐스트 송수신.
- **테스트 방법**: C6에서 패킷 송출 후, S3 게이트웨이의 `OnDataRecv` 콜백 로그 확인.
- **PASS 기준**:
  - S3 Serial Monitor에 `[ESP-NOW RX] Hanger: HC-000001, State: PRESENT, UID: 04A1...` 출력.
  - 옷장 문을 닫은 상태에서도 실측 RSSI가 -75dBm 이상 유지.
  - 패킷 수신 성공률 > 98%.
- **결함 격리**:
  - 패킷 미수신 시: C6와 S3의 Wi-Fi Channel이 동일한지(`CHANNEL = 6`) 확인, MAC 필터링 여부 점검.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 5. S3 Gateway → Backend Server HTTP 상태 업로드
- **테스트 내용**: S3 게이트웨이가 Wi-Fi Station으로 백엔드 서버에 접속하여 `POST /api/gateway/status` 전송.
- **테스트 방법**: S3 `config.h`에 실제 서버 IP(`http://192.168.x.x:8787`)와 `DEVICE_TOKEN` 설정 후 기동.
- **PASS 기준**:
  - 서버 터미널에 `POST /api/gateway/status 200 OK` 기록.
  - 서버 DB에 게이트웨이(`GW-00A1B2`)가 `ONLINE`으로 등록됨.
- **결함 격리**:
  - HTTP 401: `DEVICE_TOKEN` 불일치.
  - HTTP 타임아웃: 방화벽 포트 8787 개방 여부 및 공유기 동일 서브넷 확인.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 6. 백엔드 Reconcile & 의류-옷걸이 매핑 검증
- **테스트 내용**: 물리 태그 거치 시 백엔드가 의류 DB와 매칭하여 `IN_WARDROBE` 상태로 확정하는지 검증.
- **PASS 기준**:
  - 등록된 옷(`04A1...`): Hanger `PRESENT` + Garment `IN_WARDROBE` (`currentHanger: HC-000001`).
  - 미등록 태그: Hanger `UNKNOWN_TAG` + Garment 상태 불변.
  - 태그 제거: Hanger `EMPTY` + Garment `OUT` (`currentHanger: null`).
  - `data/wardrobe.json`에 최신 상태 즉시 영속화.
- **태그**: `SOFTWARE_VERIFIED` (실물 연동 시 자동 통과)

---

### Stage 7. Web & Mobile Client 실시간 WebSocket 수신 검증
- **테스트 내용**: 실물 하드웨어 거치 이벤트가 브라우저 및 스마트폰 앱 화면에 지연 없이 실시간 갱신되는지 확인.
- **PASS 기준**:
  - 물리적으로 옷을 걸었을 때, 앱 화면의 옷 카드에 **`옷장 안 · HC-000001`** 배지가 0.5초 이내에 갱신됨.
  - WebSocket 끊김 없이 `hanger.state` 이벤트 수신.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 8. FIND 명령 송출 및 C6 실물 LED 지속 점멸 검증
- **테스트 내용**: 앱에서 `[이 코디 옷 찾기]` 클릭 시 S3를 거쳐 C6의 실물 GPIO 핀(`D0 / GPIO0`)에 연결된 LED가 지속 점멸하는지 확인.
- **테스트 방법**: 앱에서 FIND 요청 → C6 오실로스코프/실물 LED 관찰.
- **PASS 기준**:
  - C6의 LED가 0.5초 주기로 부드럽게 점멸 시작.
  - `durationMs: 0` 전달 시 5분(`LED_SAFETY_TIMEOUT_MS`) 동안 점멸 유지.
  - 앱에서 `[LED 끄기]` 클릭 시 0.5초 내에 즉시 소등.
- **결함 격리**:
  - LED 미점등 시: GPIO 핀 번호(`LED_PIN`), 전류 제한 저항(220Ω~330Ω), TR 드라이버 회로 점검.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 9. C6 Application ACK 응답 & 앱 "찾는 중" 상태 확정
- **테스트 내용**: C6가 LED 점멸을 개시한 후 S3를 거쳐 서버로 `POST /api/gateway/ack` (result: "OK")를 전송하는지 확인.
- **PASS 기준**:
  - 서버의 `db.commands` 상태가 `SENT` → `ACKED`로 전환됨.
  - 앱 화면의 옷 카드가 주황색 펄스 테두리로 전환되며 **"LED 점멸 시작됨 (찾는 중)"**으로 표시됨.
- **태그**: `REQUIRES_PHYSICAL_TEST`

---

### Stage 10. 전원 탈착, 30초 OFFLINE 타임아웃 & 채널 복원력 검증
- **테스트 내용**: 옷걸이를 물리적으로 옷봉에서 들어 올렸을 때(전원 차단)의 시스템 복원력 점검.
- **테스트 방법**:
  1. Hanger #1을 옷봉에서 분리 → 30초 대기 → 상태 확인.
  2. Hanger #1을 다시 옷봉에 거치 → 전원 인가 → 상태 복구 확인.
- **PASS 기준**:
  - 분리 후 30초 경과 시 서버 및 앱 화면에 **`OFFLINE (연결 끊김)`** 배지 정상 표시.
  - 다시 거치 시 1초 이내에 C6 부팅 후 상태를 재보고하여 **`PRESENT / IN_WARDROBE`**로 완벽 자동 복구.
- **태그**: `REQUIRES_PHYSICAL_TEST`
