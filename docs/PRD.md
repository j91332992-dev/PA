# Smart Wardrobe Master PRD V2
## ESP-NOW 주 통신 + BLE Emergency 하이브리드 스마트 옷걸이

## 0. 프로젝트 목적

본 프로젝트는 단순한 전시용 데모가 아니라 **실제 사용 가능한 스마트 옷장 서비스 프로토타입**을 제작하는 것을 목표로 한다.

사용자는 기존 옷장 사용 습관을 바꾸지 않아야 한다.

사용 과정은 다음과 같아야 한다.

1. 옷을 일반적으로 옷걸이에 건다.
2. 스마트 옷걸이를 옷봉 아무 위치에 건다.
3. 끝.

이후 시스템이 자동으로 다음을 수행한다.

- 옷의 NFC 태그 자동 인식
- 어떤 옷이 어떤 옷걸이에 있는지 판단
- 옷걸이에 옷이 없는 `EMPTY` 상태 판단
- 옷걸이가 옷봉에서 제거된 `OFFLINE` 상태 판단
- Gateway로 상태 전송
- Cloud DB 반영
- Web/PWA에서 실시간 확인
- 특정 옷 검색
- 해당 옷걸이 LED 점멸
- 향후 착용 기록, 세탁 관리, 날씨 기반 코디 추천 확장

---

# 1. 핵심 제품 원칙

다음 조건은 절대로 훼손하지 않는다.

- 일반 원형 옷봉 형태 유지
- 특정 슬롯 없음
- 지정된 옷걸이 위치 없음
- V-Groove 없음
- 위치 고정용 레일 없음
- 옷걸이를 옷봉 전체 어느 위치에나 걸 수 있음
- 걸린 상태에서 좌우로 자유롭게 밀 수 있음
- 옷걸이별 배터리 없음
- 옷에는 수동 NFC 태그만 사용
- 사용 중 별도 페어링 작업 없음
- 자석은 위치를 고정하는 용도가 아니라 회전 방향을 보조하는 용도
- 옷걸이 데이터는 옷봉 전극을 통해 보내지 않고 무선으로 전송

---

# 2. 실제 사용 부품

## 의류

### NTAG213 NFC Tag

- 13.56 MHz
- NFC Forum Type 2
- ISO/IEC 14443 Type A
- 각 의류의 고유 UID 식별
- 옷 이름/사진/카테고리 등은 태그에 저장하지 않고 서버 DB에서 UID와 매핑

프로토타입에서는 현재 구매한 NTAG213을 사용한다.

향후 제품화 시 동일한 프로토콜을 사용할 수 있는 세탁 대응 태그를 검토한다.

---

## 스마트 옷걸이

### PN532 NFC RFID Card Sensor Module

실제 사용하는 일반적인 Red PCB V3-style PN532 모듈을 기준으로 한다.

역할:

- NTAG213 탐색
- UID 읽기

기본 통신:

- I²C

실제 모듈의 VCC 허용 범위와 I²C 모드 선택 스위치/점퍼는 실물 보드 인쇄와 제품 설명을 확인한 뒤 최종 확정한다.

### Seeed Studio XIAO ESP32-C6

옷걸이 메인 MCU.

* **안테나 구조 (단일 RF 자원 공유):** Wi-Fi와 Bluetooth LE 기능이 하나의 SoC에 통합되어 있으며, 단일 2.4GHz RF 자원을 시간 분할(Coexistence) 방식으로 공유한다. 따라서 ESP-NOW와 BLE를 동시에 강하게 돌리지 않고 모드 전환 방식으로 사용한다.

역할:

- PN532 제어
- NFC UID 처리
- 상태 머신
- ESP-NOW 송수신 (평상시)
- BLE Advertising 송출 (비상시)
- LED 제어
- 장치 ID 관리
- 오류 복구
- 상태 Debounce

### LED

- 옷 찾기
- 장치 식별
- 진단용 표시

### LED Current Limiting Resistor

기본값:

- 330Ω

### 2-Pin Pogo Pin Spring Contact

두 접점을 모두 동일한 +5V에 병렬 연결한다.

목적:

- +5V 동박과 안정적인 전원 접촉
- 한 접점이 순간적으로 떨어져도 다른 접점을 통해 전원 유지 가능성 향상

### Pogo Pin Clip / Holder

포고핀 기계적 고정.

### Neodymium Round Magnet

역할:

- 옷걸이 회전 방향 정렬
- +5V 포고핀이 동박 위치를 유지하도록 보조

절대로 특정 X축 위치에 옷걸이를 고정하는 구조로 만들지 않는다.

### 100µF 16V Electrolytic Capacitor

옷걸이 전원 입력에 배치한다.

연결:

- `+` → +5V
- `-` → GND

목적:

- 옷걸이를 좌우 이동할 때 발생할 수 있는 순간 접촉 불량 방어
- ESP32-C6 반복 Reset 방지
- (참고: 커패시터의 실제 전원 유지 시간은 허용 전압 강하폭($\Delta V$)에 따라 달라지므로, 실측을 통해 최적 용량을 검증한다.)

### Hanger

일반 옷걸이 형상을 유지한다.

### 2P Wire

내부 +5V/GND 배선.

### Epoxy Adhesive

- 자석
- 포고핀 Holder
- 배선
- 케이스

고정에 사용.

### 3D Printed Case / Parts / Jig

제작 대상:

- XIAO ESP32-C6 Holder
- PN532 Holder
- Pogo Pin Holder
- Magnet Holder
- LED Holder
- Wire Guide
- Hanger Electronics Cover
- Assembly Jig
- Alignment Jig
- Test Jig

---

# 3. 스마트 옷봉

사용 부품:

- 일반 금속 원형 옷봉
- Copper Foil Tape
- Kapton Tape
- Steel / Ferromagnetic Sheet Roll
- Fuse
- 2P Wire
- **5V 4A 이상 어댑터** (초기 설계 기준값이며, 최종 요구 용량은 50대 최대 부하 시의 끝단 전압 강하 실측을 통해 확정한다)

## 전원 전극 구조

금속 옷봉 자체:

`GND`

옷봉을 따라 연속으로 설치되는 동박:

`+5V`

단면:

```text
+5V Copper Foil
=====================

Kapton Insulation
---------------------

Metal Clothes Rod
█████████████████████
        GND
```

+5V 동박은 봉 전체 길이에 연속적으로 존재해야 한다.

특정 위치별 접점 패드를 만들지 않는다.

---

# 4. 자석 정렬 구조

옷봉에는 Steel / Ferromagnetic Sheet Roll을 길이 방향으로 연속 배치한다.

옷걸이 후크 내부에는 작은 Neodymium Round Magnet을 배치한다.

역할:

```text
Magnet
   ↓
Steel Strip
```

을 이용해 옷걸이가 특정 회전 방향을 선호하도록 한다.

중요:

- 좌우 이동을 방해하면 안 됨
- 자석이 철지에 직접 강하게 달라붙게 하지 않음
- 3D 프린트 플라스틱 두께를 사이에 두어 자력을 완화할 수 있음
- 자석 세기는 실제 옷 무게를 걸고 조정
- PN532 안테나와 자석/금속부는 가능한 한 떨어뜨림

---

# 5. Gateway

### Seeed Studio XIAO ESP32-S3

역할:

- ESP-NOW Gateway
- 모든 Hanger 상태 수집
- Hanger 상태 Table 유지
- Wi-Fi 연결
- Cloud 통신
- LED 명령 Routing
- Local fallback
- OTA
- 진단 로그

전원:

- 5V 3A Smartphone Charger

---

# 6. PN532 ↔ XIAO ESP32-C6

기본 통신은 I²C를 사용한다.

기본 Pin Assignment:

```text
PN532             XIAO ESP32-C6

SDA        →       D4 / SDA
SCL        →       D5 / SCL
GND        →       GND
VCC        →       PN532 실제 모듈 전원 사양 확인 후 연결
```

LED 기본안:

```text
XIAO D1
   ↓
330Ω
   ↓
LED Anode

LED Cathode
   ↓
GND
```

실제 펌웨어 작성 직전 공식 XIAO ESP32-C6 Pinout과 사용 핀 충돌 여부를 검증하고 `HARDWARE_PINMAP.md`에 최종 기록한다.

---

# 7. ESP-NOW 통신 구조

## 핵심 설계

100개 이상의 옷걸이까지 고려하므로 모든 Hanger를 S3의 ESP-NOW Unicast Peer로 등록하는 구조를 기본으로 사용하지 않는다.

상태 전달의 기본 방식:

**ESP-NOW Broadcast**

```text
Hanger 001 ─┐
Hanger 002 ─┤
Hanger 003 ─┤
...
Hanger 100 ─┤
            ↓
      ESP32-S3 Gateway
```

---

# 8. Hanger → Gateway 상태 패킷

Binary Protocol 사용을 기본으로 한다.

JSON 문자열을 ESP-NOW 내부 프로토콜로 직접 사용하지 않는다.

예시 논리 필드:

```text
protocolVersion
messageType
hangerId
state
tagUid[7]
sequence
errorFlags
firmwareVersion
```

상태:

- PRESENT
- EMPTY
- UNKNOWN_TAG
- UNSTABLE
- CONFLICT

Gateway가 Hanger 신호를 일정 시간 이상 받지 못하면:

- OFFLINE

으로 판정한다.

---

# 9. Hanger ID

사용자가 H01/H02를 수동으로 입력하지 않는다.

기본 Hardware ID (Factory ID):

제품 생산 시 부여되는 고유 일련번호(Factory ID)를 기준으로 관리한다.

예:

`HC-000001`

내부 시스템 저장:
- `hangerId` = `HC-000001` (Factory ID)
- `macAddress` = 실제 기기의 MAC 주소

이 둘을 분리하여 저장함으로써, 기기 불량으로 교체 시 논리적 ID(Factory ID)를 유지한 채 MAC만 교체할 수 있는 유연성을 확보한다.

Web에서는 사용자가:

`왼쪽 옷걸이`, `옷걸이 12`

같은 별칭을 붙일 수 있다.

---

# 10. 100개 이상을 위한 전송 정책

절대로 100개 Hanger가 500ms마다 무조건 Broadcast하지 않는다.

기본 정책:

### 상태 변경 시

즉시 전송.

예:

- EMPTY → PRESENT
- PRESENT → EMPTY
- UID 변경
- Error 발생

상태 변경 패킷은 신뢰성 확보를 위해 짧은 Random Delay를 두고 2~3회 반복 가능하다.

### 상태 변화가 없을 때

Heartbeat:

약 5~10초.

각 Hanger마다 Random Jitter를 적용한다.

예:

```text
H01 = 5.3 sec
H02 = 6.1 sec
H03 = 5.7 sec
...
```

**RF 패킷 충돌 및 통신 처리 집중 현상을 완화**한다. (주의: 통신을 분산시킨다고 물리적인 LED 전력 과부하가 막아지는 것은 아니므로, LED 전력 피크 분산은 PWM 및 명령 스케줄링으로 별도 처리한다.)

모든 주기는 Config에서 변경 가능하게 한다.

---

# 11. Gateway → Hanger 명령

100개 Hanger를 모두 Peer로 등록하지 않아도 되도록 기본 명령 역시 Broadcast 기반 프로토콜을 지원한다.

예:

```json
{
  "type": "COMMAND",
  "target": "HC-0073",
  "command": "LED_BLINK",
  "commandId": 1532
}
```

모든 Hanger가 메시지를 받더라도:

```text
targetId != myId
→ 무시

targetId == myId
→ 실행
```

한다.

실행 후 대상 Hanger는 ACK 메시지를 Gateway에 반환한다.

---

# 12. 지원 명령

최소:

- LED_BLINK
- LED_ON
- LED_OFF
- IDENTIFY
- PING
- GET_STATUS

선택:

- REBOOT
- CONFIG_UPDATE

---

# 13. ESP-NOW 신뢰성

반드시 구현:

- sequence number
- commandId
- duplicate suppression
- ACK (충돌 방지를 위한 Random Backoff 필수 적용)
- retry
- timeout
- Random Backoff
- gatewayId
- protocolVersion

**ACK 충돌 방지 로직:** 
100대의 옷걸이가 Broadcast 명령을 수신한 후 동시에 ACK를 반환하면 Gateway 측에서 극심한 패킷 충돌이 발생한다. 따라서 대상 Hanger들은 수신 즉시 응답하지 않고 `0~X ms` 범위의 Random Delay를 거친 후 ACK를 전송하며, Gateway는 `commandId + hangerId`를 기반으로 이를 집계한다.

LED 찾기와 같은 사용자 명령은 ACK를 받지 못하면 제한된 횟수만큼 재전송한다.

---

# 14. ESP-NOW Wi-Fi Channel 문제 및 해결책 (Channel Manager)

이 방식의 가장 중요한 과제이며, Hanger가 배터리 제약이 없다는 점을 활용하여 **Channel Sweep** 구조를 채택한다.

## 14.1. Channel Manager 핵심 로직

**Gateway (S3) 측 로직:**
1. 사용자의 Wi-Fi AP에 접속
2. 현재 할당된 Wi-Fi Channel 확인
3. ESP-NOW를 해당 동일 Channel에서 운용
4. `GATEWAY_BEACON` (gatewayId 포함) 주기적 Broadcast
5. **[채널 변경 대응]** 공유기 채널이 변경될 경우, Gateway는 즉시 ESP-NOW를 새 채널로 재초기화하고, 미아가 된 Hanger들이 Sweep 중 발견할 수 있도록 **NEW_CHANNEL Beacon**을 집중 송신한다. (집중 송신 유지 시간은 실측 후 Config로 정의)

**Hanger (C6) 측 로직:**
1. **BOOT:** 전원 인가 후 NVS에 저장된 `Last Channel` 먼저 시도
2. **Gateway 탐색:** 해당 채널에서 `GATEWAY_BEACON` 수신 대기
   - **[성공]** 즉시 NORMAL 통신 모드 진입
   - **[실패]** (AP 채널이 변경된 경우) Channel Sweep 모드 진입
3. **Channel Sweep:** 채널 1부터 13까지 순차적으로 변경하며 게이트웨이 탐색 (목표: 복구 시간 실측 후 확정)
4. **Channel 저장:** 새 채널에서 Gateway를 발견하면 NVS에 덮어쓰고 NORMAL 모드 복귀

---

# 15. ESP-NOW 보안

100개 이상을 염두에 둔 Broadcast 구조에서는 단순한 `targetId`만 믿지 않는다.

Protocol에는 다음 보안/검증 확장 필드를 고려한다.

- gatewayId
- deviceId
- sequence
- nonce
- message authentication field
- replay 방지

초기 프로토타입에서는 최소한 등록된 Gateway ID와 Protocol Version, Sequence 검증을 구현한다.

제품화 단계에서는 Broadcast 메시지 인증 방식을 강화할 수 있도록 Transport Layer 내부에서 분리한다.

---

# 16. 통신 추상화

매우 중요하다.

애플리케이션 코드 내부에서 직접 `esp_now_send()`를 호출하는 구조로 만들지 않는다.

다음 Interface를 만든다.

```text
Transport

initialize()
sendStatus()
sendAck()
sendCommand()
poll()
isReady()
```

ESP-NOW 구현체:

`EspNowTransport`

향후:

`BleTransport`

로 교체할 수 있도록 한다.

NFC/State Machine/Web 기능은 Transport 구현을 알지 않아야 한다.

---

# 17. Hanger State Machine

```text
BOOT
 ↓
POWER_STABILIZE
 ↓
PN532_INIT
 ↓
NFC_SCAN
 ↓
 ┌─────────────┬─────────────┐
 TAG           NO TAG        ERROR
 ↓             ↓             ↓
PRESENT       EMPTY        UNSTABLE
```

NFC 한 번 인식/미인식만으로 상태를 바꾸지 않는다.

예:

- 동일 UID 연속 2~3회 → PRESENT
- 일정 시간 미인식 → EMPTY
- UID가 반복적으로 나타났다 사라짐 → UNSTABLE

실제 기준은 테스트 후 Config에서 튜닝한다.

---

# 18. Gateway State Manager

Gateway는 다음 Table을 유지한다.

```text
hangerId
state
tagUid
lastSeen
lastSequence
rssi
errorFlags
firmwareVersion
```

Offline 판정:

`lastSeen > OFFLINE_TIMEOUT`

기본 초기값은 10~30초 범위에서 테스트 후 결정한다.

---

# 19. Gateway → Cloud

Main Service는 Local 전용이 아니다.

Gateway:

```text
ESP-NOW
   ↓
XIAO ESP32-S3
   ↓
Wi-Fi
   ↓
Internet
   ↓
Cloud
```

기본 Cloud Communication 후보:

- MQTT over TLS
- HTTPS

IoT 상태 스트림에는 MQTT/TLS를 우선 검토한다.

Device Management/API는 HTTPS 병행 가능하다.

---

# 20. Backend

필수 기능:

- Authentication
- User
- Wardrobe
- Gateway
- Hanger
- Garment
- NFC UID Mapping
- Hanger State
- Garment State
- Event History
- LED Find Command
- Device Command ACK
- Realtime Web Update

---

# 21. Database

최소 엔티티:

```text
User
Wardrobe
Gateway
Hanger
Garment
HangerState
GarmentState
DeviceEvent
DeviceCommand
```

향후:

```text
WearHistory
LaundryHistory
OutfitRecommendation
```

추가.

---

# 22. Web / PWA

스마트폰과 PC에서 동일 서비스 사용 가능하게 한다.

Native App을 V1에서 필수로 만들지 않는다.

Responsive Web + PWA 우선.

페이지:

```text
/login
/dashboard
/clothes
/clothes/:id
/hangers
/gateway
/settings
/setup
/live-demo
```

---

# 23. 시스템 핵심 상태 (상태 머신 정의)

상태 용어를 명확히 분리하여 관리한다.

**Hanger State (옷걸이 기기 상태):**
- `PRESENT`: 옷걸이에 정상적으로 옷(NFC)이 인식된 상태
- `EMPTY`: 옷걸이 기기는 살아있으나 옷이 없는 상태
- `OFFLINE`: Gateway가 설정된 시간(Timeout) 동안 Hanger의 상태/Heartbeat를 수신하지 못한 상태. (물리적 제거 여부를 직접 측정하는 센서는 없으며 Timeout으로 간주함)
- `UNSTABLE`: UID가 짧은 시간 내 반복적으로 나타났다 사라지는 등 접촉 불량 상태

**Garment State (의류 상태):**
- `IN_WARDROBE`: 옷이 옷장에 보관 중인 상태
- `OUT`: 옷이 밖으로 나간 상태 (착용 중, 세탁 중 등)
- `UNKNOWN`: 등록되지 않은 옷

**오류 (Event):**
- `CONFLICT`: 하나의 옷이 두 개의 옷걸이에서 동시에 인식되는 등 논리적 오류
- `UNKNOWN_TAG`: 미등록 NFC 태그 감지

---

# 24. 옷 등록

새 UID 감지:

```text
UNKNOWN_TAG
↓
Cloud
↓
Web 알림
"새로운 옷이 감지되었습니다"
```

사용자가:

- 사진
- 이름
- 종류
- 색상
- 계절
- 브랜드
- 메모

등록.

그 이후에는 완전 자동.

---

# 25. 옷 찾기

```text
Web
 ↓
Backend
 ↓
Gateway
 ↓ ESP-NOW Broadcast Command
Target Hanger
 ↓
ACK
 ↓
LED Blink
```

웹에는:

- 명령 전송 중
- Gateway 전달 완료
- Hanger ACK
- LED 실행 완료

상태를 보여준다.

---

# 26. 비상용 BLE 하이브리드 모드 (Local Fallback)

인터넷 장애나 Gateway 고장 시 스마트 옷장이 고철이 되는 것을 방지하기 위해, 옷걸이(C6)의 내장 BLE를 비상용으로 활용한다.

## 26.1. BLE 전환 트리거 구조

1. **Trigger A: 클라우드 접속 장애**
   - Gateway가 인터넷 단절 감지 시 즉시 전환하지 않고 **Debounce(Hysteresis)** 적용 (예: `CLOUD_FAIL_CONFIRM = 3회 연속 실패`).
   - 장애 확정 시 S3가 ESP-NOW Broadcast로 *"EMERGENCY_BLE"* 명령 하달.
   - Hanger들은 ESP-NOW 멈춤 ➡️ BLE Advertising 시작.

2. **Trigger B: Gateway 하드웨어 장애**
   - Hanger 내부 타이머 작동. Gateway의 `GATEWAY_BEACON`을 1분 이상 받지 못하면 자체적으로 Gateway 사망 판단(Timeout).
   - Hanger 독자적으로 ESP-NOW 멈춤 ➡️ BLE Advertising 시작.

## 26.2. 정상 모드(ESP-NOW) 복귀 조건

BLE 비상 모드로 동작 중이더라도, 옷걸이는 주기적으로 Gateway의 생존 여부를 백그라운드에서 스캔한다.
- **복구 조건:** Gateway가 다시 살아나 `GATEWAY_BEACON`을 재송신하고, 이를 Hanger가 **N회 연속 수신**하여 정상 상태로 확정(Debounce)하면,
- **복구 액션:** Hanger는 BLE Advertising을 중단하고 즉시 ESP-NOW NORMAL 모드로 복귀하여 통신을 재개한다.

## 26.3. 스마트폰 직결 제어

사용자는 서버 장애 시 앱에서 **[오프라인 비상 블루투스 모드]**를 켠다.
스마트폰이 반경 10m 내의 옷걸이 BLE 신호를 직접 스캔하여 인터넷 없이도 Hanger 식별 및 1:1 LED 제어가 가능해진다.

---

# 27. 날씨/코디 기능

V1 Core 완성 후 추가.

현재 DB상 `IN_WARDROBE`인 옷만 추천 후보로 사용한다.

초기 추천은 AI보다 규칙 기반.

입력:

- 기온
- 체감온도
- 강수
- 계절
- 색상
- 최근 착용
- 세탁상태
- 사용자 선호

추천 결과의 각 옷에 대해 `FIND OUTFIT`을 누르면 여러 해당 Hanger LED를 순차/동시에 점멸 가능하게 확장한다.

---

# 28. Live Demo

`/live-demo`

좌측:

- 실제 옷장 카메라

우측:

- Gateway 상태
- Hanger 상태
- 옷 상태
- Event Log
- Find Command
- ACK

실제 행동과 서비스 반응을 한 화면에서 보여준다.

---

# 29. OTA / Update

Gateway S3:

Wi-Fi OTA 지원을 목표.

Hanger C6:

V1에서는 USB Update 우선.

향후 Gateway를 통한 OTA 가능성 검토.

필수:

`docs/UPDATE_GUIDE.md`

---

# 30. 개발 단계

## Phase 1 — Hardware Design

코딩 전에:

- Exact Pin Map
- Wiring
- Power
- Pogo Geometry
- Magnet Alignment
- PN532 placement
- 3D Parts
- Fuse
- Capacitor

완성.

## Phase 2 — Unit Hardware

NTAG213 → PN532 → C6 확인.

## Phase 3 — ESP-NOW Transport

C6 1대 ↔ S3.

## Phase 4 — End-to-End V1

```text
NTAG
→ PN532
→ C6
→ ESP-NOW
→ S3
→ Backend
→ Web
```

## Phase 5 — Reverse Command

```text
Web
→ Backend
→ S3
→ ESP-NOW
→ C6
→ LED
```

## Phase 6 — Multi-Hanger

1 → 3 → 5 → 10대.

## Phase 7 — Scale Test

가능한 범위에서 Traffic Simulator 포함.

30/50/100 Hanger에 해당하는 패킷 부하를 Gateway에서 시뮬레이션한다.

## Phase 8 — Cloud/Local fallback

## Phase 9 — Service Features

## Phase 10 — Deployment/OTA

---

# 31. 반드시 생성할 문서

```text
docs/
  HARDWARE_A_TO_Z_GUIDE.md
  HARDWARE_PINMAP.md
  HARDWARE_WIRING.md
  HARDWARE_POWER.md
  HARDWARE_HANGER_BUILD.md
  HARDWARE_ROD_BUILD.md
  MAGNET_ALIGNMENT_GUIDE.md
  PN532_MODULE_CHECK.md
  3D_PRINT_PARTS_GUIDE.md

  SOFTWARE_A_TO_Z_GUIDE.md
  SOFTWARE_ARCHITECTURE.md

  ESPNOW_PROTOCOL.md
  ESPNOW_CHANNEL_STRATEGY.md
  DEVICE_STATE_MACHINE.md

  BACKEND_API.md
  DATABASE_SCHEMA.md
  WEB_APP_GUIDE.md

  DEPLOYMENT_GUIDE.md
  UPDATE_GUIDE.md
  TEST_GUIDE.md
  TROUBLESHOOTING.md
```

---

# 32. Physical Test

검증 전에는 완료라고 표시하지 않는다.

실물 검증 대상은:

`REQUIRES_PHYSICAL_TEST`

표시.

반드시 시험해야 할 14대 필수 검증 (핵심 실측 포함):

1. NFC 반복 인식 및 옷 복귀/제거 상태 전이
2. 좌우 이동 중 전원 유지 및 커패시터 $\Delta V$ 방어 실측
3. **끝단 전압 강하 시험:** 1, 10, 25, 50번 Hanger 위치별 무부하/통신/LED 점등 시 전압 측정
4. **최대 부하 시험:** 10, 25, 50대 동시 LED 점등 시 전압 유지율 및 어댑터 발열 측정
5. 자석 정렬 구조의 기계적 간섭 여부
6. **목표 Latency 측정:**
   - 통신 성능 목표: **Gateway Command 송신 ➡️ Hanger LED ON (≤ 100ms)**
   - 사용자 체감 목표: **Web Command 생성 ➡️ Hanger LED ON (네트워크 지연 포함 실측 평가)**
7. **규모별 패킷 유실률 시험:** 10, 30, 50, 100대 트래픽 시뮬레이션 시 송수신 Loss % 측정
8. Gateway Wi-Fi + ESP-NOW 동시 사용 시 Coexistence 병목 확인
9. 공유기 Wi-Fi Channel 강제 변경에 따른 Channel Sweep 자동 복구 소요 시간 실측
10. Gateway 재부팅 및 Hanger 단독 재부팅
11. Internet 단절 및 Cloud 장애 시 Trigger A (Debounce 작동) 정상 전환
12. Gateway 완전 다운 시 Trigger B (Timeout) 정상 전환
13. 스마트폰 비상용 BLE 모드(Local Fallback) 다이렉트 통신 및 제어
14. 장시간(1시간 이상) 연속 운영 시 시스템 크래시/메모리 릭 여부

---

# 33. Acceptance Criteria

최종적으로:

- 옷을 걸기만 하면 자동 인식
- 옷을 빼면 자동 OUT
- 빈 옷걸이는 EMPTY
- 옷걸이를 봉에서 빼면 OFFLINE
- 옷걸이는 봉 어디든 위치 가능
- 옷걸이를 좌우로 밀 수 있음
- 웹 상태 자동 변경
- 다른 네트워크의 휴대폰에서도 Public URL로 확인
- Find 클릭 시 해당 Hanger LED만 점멸
- Internet 장애 시 Local fallback 사용 가능

해야 한다.

---

# 34. Codex 작업 지시

바로 코딩부터 하지 않는다.

1. Repository Audit
2. Hardware A-to-Z 작성
3. Software Architecture 작성
4. ESP-NOW Protocol 작성
5. Channel Strategy 작성
6. Hardware Unit Test Code
7. Hanger Firmware
8. Gateway Firmware
9. Backend
10. Web/PWA
11. Integration
12. Scale Test
13. Deployment
14. Update Documentation

각 단계 완료 시:

- 생성 파일
- 구현 내용
- 테스트 방법
- 성공 기준
- 미검증 항목
- 다음 단계

를 보고한다.

---

# 35. 이 PRD의 기술적 철학

ESP-NOW를 단순히 "ESP32끼리 되니까" 선택하는 것이 아니다.

본 안은:

- XIAO ESP32-C6 ↔ XIAO ESP32-S3 조합 활용
- 양방향 Command/ACK 단순화
- 빠른 프로토타입 개발
- Broadcast 기반 100개 이상 확장 가능성
- Cloud Gateway 구조

를 목표로 한다.

단 제품화 단계에서 Wi-Fi Channel Synchronization이 가장 중요한 검증 포인트이며, 이 문제가 실제 시험에서 불안정할 경우 BLE Transport로 전환할 수 있도록 통신 계층을 반드시 추상화한다.

**통신 아키텍처 결정 논거 및 방어 전략 (Defense Strategy):**
일반적인 환경에서는 범용성 때문에 BLE가 권장되나, 본 프로젝트의 **'배터리 제약 없는 5V 전원'** 특성을 살려 ESP-NOW의 약점(채널 종속성, 호환성)을 소프트웨어 기반으로 완화했다.
* 전력 제약이 없음을 활용한 적극적인 Channel Sweep으로 미아 현상 극복
* C6 칩의 SoC 통합 구조(단일 RF 공유)를 활용해 비상시에만 BLE로 전환하는 하이브리드 Fall-safe 구현
* 실측 기반 목표(전압 강하, 패킷 유실률, 100ms 지연)를 통해 성능 확정

단, 이 모든 논리적 방어는 **실제 10~100대 실물 하드웨어 검증을 통한 실측값 획득 후 확정**하며, 이 문제가 실제 시험에서 도저히 극복 불가능할 최악의 경우를 대비해 언제든 BLE Transport로 전환할 수 있도록 통신 계층을 16번 항목과 같이 반드시 추상화한다.