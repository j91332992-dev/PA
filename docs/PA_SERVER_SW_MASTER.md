# PA Smart Wardrobe — Server / Software Architecture Master Specification

본 문서는 **PA Smart Wardrobe (스마트 옷장) 시스템의 백엔드 서버, 소프트웨어 아키텍처, 상태 머신, 가상 하드웨어 시뮬레이터 및 코디 추천 엔진**을 총괄하는 공식 Master Reference 문서입니다.

---

## 1. 시스템 목적 및 개요 (System Purpose)

PA Smart Wardrobe는 **물리적 스마트 옷걸이(ESP32-C6 + PN532 NFC Reader)**와 **중앙 게이트웨이(ESP32-S3)**, **Node.js 백엔드 서버**, 그리고 **사용자 클라이언트(Mobile App / Web Reference)**가 유기적으로 연동되는 지능형 의류 관리 및 코디 지원 시스템입니다.

### 핵심 가치 및 사용자 시나리오
1. **의류 거치 자동 감지**: 옷에 부착된 NTAG213 NFC 태그를 옷걸이에 거치하면, 물리적 하드웨어가 0.5초 이내에 태그를 읽어 서버에 상태를 동기화합니다.
2. **실시간 의류 위치 추적**: 사용자가 옷을 꺼내 입거나 세탁 중(`OUT`)인지, 옷장 안 특정 옷걸이(`IN_WARDROBE`)에 걸려 있는지 실시간으로 파악합니다.
3. **지속 점멸 의류 찾기 (Persistent FIND)**: 사용자가 앱에서 옷 또는 코디를 찾으면, 해당 옷걸이의 LED가 지속 점멸(Blinking)하여 어두운 옷장 속에서도 즉시 시각적으로 식별할 수 있습니다.
4. **스마트 코디 추천 (Smart Outfit Recommendation)**: 실제 옷장에 있는 옷(`IN_WARDROBE`)만을 대상으로 날씨(Open-Meteo)와 상황(출근, 캠퍼스, 데이트, 운동)을 분석하여 최적의 상·하의·아우터 조합을 추천하고 한 번의 터치로 관련 옷걸이들의 LED를 동시 점멸합니다.

---

## 2. 전체 시스템 아키텍처 (End-to-End Architecture)

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PA SMART WARDROBE ECOSYSTEM                                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘

 [Physical Smart Hangers]              [Central Gateway]                     [Backend Server]
  ESP32-C6 + PN532 (I2C)                   ESP32-S3                          Node.js (HTTP/WS)
 ┌──────────────────────┐             ┌─────────────────┐             ┌─────────────────────────┐
 │ Hanger #1 (HC-000001)│             │                 │             │ • REST API Server       │
 │   • NTAG213 Scanning │             │ • ESP-NOW Rx/Tx │             │ • WebSocket Event Hub   │
 │   • Status Broadcast │──ESP-NOW───▶│ • Wi-Fi Station │──HTTP POST─▶│ • Reconcile Engine      │
 │   • LED Blink / Off  │◀──(2.4GHz)──│ • HTTP Forward  │◀──HTTP GET──│ • Wardrobe Persistence  │
 └──────────────────────┘             │ • ACK Forward   │             │ • Recommendation Engine │
 ┌──────────────────────┐             └─────────────────┘             └─────────────────────────┘
 │ Hanger #2 (HC-000002)│                      ▲                                   ▲
 │   ...                │                      │ (ESP-NOW Broadcast)               │ (REST / WS)
 └──────────────────────┘                      │                                   ▼
                                      ┌─────────────────┐             ┌─────────────────────────┐
                                      │ Virtual Hardware│             │  Client Applications    │
                                      │   Simulator     │             │ • Seongjun Mobile App   │
                                      │ (DEV / TEST E2E)│             │ • Web Reference Client  │
                                      └─────────────────┘             └─────────────────────────┘
```

---

## 3. 핵심 데이터 흐름 (Data & Control Flows)

### 3.1 Hardware → Server: 태그 거치 및 상태 보고 흐름
```text
[1. 태그 거치] 사용자가 옷(NTAG213)을 Hanger(HC-000001)에 거치
      │ PN532 감지 (14자리 HEX UID)
      ▼
[2. ESP-NOW 패킷 브로드캐스트] C6 -> S3 (sw::Packet, 139 bytes)
      │ 2.4GHz 비연결형 초고속 전송 (< 5ms)
      ▼
[3. Gateway HTTP 포워딩] S3 -> Backend (POST /api/gateway/status, X-Gateway-Id, Bearer Token)
      │
      ▼
[4. 백엔드 Reconcile & 상태 확정]
      │ - UID가 등록된 의류인 경우: Hanger = PRESENT, Garment = IN_WARDROBE
      │ - UID가 미등록 태그인 경우: Hanger = UNKNOWN_TAG, Garment = OUT
      │ - 동일 UID가 다중 감지된 경우: Hangers = CONFLICT
      ▼
[5. 실시간 WebSocket 브로드캐스트] emit('hanger.state', { state, tagUid, garmentId, ... })
      │
      ▼
[6. 클라이언트 UI 즉시 반영] Mobile App / Web 카드 실시간 갱신 (< 100ms)
```

### 3.2 Server → Hardware: 의류 찾기(FIND) 및 소등(STOP) 흐름
```text
[1. 찾기 요청] 사용자가 앱에서 [코디 찾기] 또는 [LED 찾기] 클릭
      │ POST /api/commands (targets: ["HC-000001"], command: "LED_BLINK", durationMs: 0)
      ▼
[2. 백엔드 명령 큐잉] Command 생성 (status: "QUEUED", expiresAt: now + 15s)
      │ emit('command.queued')
      ▼
[3. 게이트웨이 명령 폴링] S3 Gateway -> GET /api/gateway/commands
      │ 서버: status = "SENT", sentAt = now()
      ▼
[4. 하드웨어 명령 송출] S3 -> ESP-NOW 브로드캐스트 (sw::Command::LED_BLINK, duration: 0)
      │
      ▼
[5. Hanger 수신 및 LED 점멸 시작] C6가 타깃 ID 일치 확인 후 LED 점멸 활성화 (5분 안전 타임아웃)
      │ C6 -> S3: ESP-NOW ACK 전송
      ▼
[6. Gateway Application ACK 전송] S3 -> Backend (POST /api/gateway/ack, result: "OK")
      │ 백엔드: command.status = "ACKED"
      │ emit('command.ack', { status: "ACKED" })
      ▼
[7. 클라이언트 상태 동기화] 앱 화면에서 "LED 점멸 시작됨 / 찾는 중" 상태 표시
      │
      ▼
[8. LED 소등 (STOP)]
      ├─ Case A: 사용자가 앱에서 [LED 끄기] 클릭 -> POST /api/commands ("LED_OFF") -> 즉시 소등
      ├─ Case B: 사용자가 옷걸이를 옷봉에서 분리 -> 물리적 전원 차단 -> 즉시 자연 소등
      └─ Case C: 방치 방지 안전망 -> 5분(`LED_SAFETY_TIMEOUT_MS`) 경과 시 C6 펌웨어 자동 소등
```

---

## 4. REST API Inventory (공식 명세)

### 4.1 클라이언트 / 사용자 API (User Token Auth)

| Method | Endpoint | Description | Request Payload | Response |
|---|---|---|---|---|
| `GET` | `/api/health` | 시스템 상태 & 게이트웨이 연결 점검 | None | `{ ok, gatewayOnline, simulationEnabled }` |
| `GET` | `/api/auth/status` | 최초 가입 필요 여부 & 세션 점검 | None | `{ setupRequired, user }` |
| `POST` | `/api/auth/signup` | 신규 사용자 등록 (최초 가입 시 관리자) | `{ email, password, name }` | `{ token, user }` (201 Created) |
| `POST` | `/api/auth/login` | 로그인 | `{ email, password }` | `{ token, user }` (200 OK) |
| `GET` | `/api/snapshot` | 옷장 전체 데이터 모델 스냅샷 | None | Full Snapshot Object |
| `POST` | `/api/garments` | 새 의류 등록 | `{ name, tagUid, category, color, season, brand, imageUrl, memo }` | Garment Object (201 Created) |
| `DELETE` | `/api/garments/:id` | 의류 등록 정보 삭제 (Hanger는 유지) | None | `{ ok: true, deletedId }` (200 OK) |
| `POST` | `/api/garments/:id/find` | 특정 의류 단일 옷걸이 FIND | `{}` | Command Object (202 Accepted) |
| `POST` | `/api/commands` | 다중 옷걸이 직접 제어 (FIND & STOP) | `{ targets, command: "LED_BLINK"|"LED_OFF", durationMs: 0 }` | Command Object (202 Accepted) |

### 4.2 하드웨어 게이트웨이 전용 API (Device Token Auth)

| Method | Endpoint | Description | Headers | Request Payload |
|---|---|---|---|---|
| `POST` | `/api/gateway/status` | 옷걸이 NFC 거치 상태 및 Heartbeat 업로드 | `X-Gateway-Id`, `Bearer <TOKEN>` | `{ hangerId, state, tagUid, sequence, bootId, channel, rssi, firmwareVersion }` |
| `GET` | `/api/gateway/commands` | 게이트웨이 대기 중 명령 폴링 | `X-Gateway-Id`, `Bearer <TOKEN>` | None (Response: `{ commands: [...] }`) |
| `POST` | `/api/gateway/ack` | 하드웨어 명령 실행 완료 ACK 보고 | `X-Gateway-Id`, `Bearer <TOKEN>` | `{ commandId, hangerId, result: "OK"|"ERROR", errorCode }` |

---

## 5. WebSocket 프로토콜 및 실시간 동기화

- **연결 URL**: `ws://<HOST>:<PORT>/ws?token=<USER_TOKEN>`
- **초기 연결 시**: 서버가 단독으로 전체 Snapshot `{ type: "snapshot", payload: <FullSnapshot> }`을 전송하여 클라이언트 로컬 캐시를 초기화합니다.
- **실시간 이벤트 목록**:
  - `snapshot`: 초기화 및 전체 갱신
  - `hanger.state`: 특정 옷걸이의 거치/UID/상태 변화
  - `hanger.offline`: 30초 무응답 옷걸이 오프라인 알림
  - `garment.created`: 새 옷 등록 알림
  - `garment.deleted`: 옷 삭제 알림
  - `command.queued`: 새 찾기 명령 큐 대기
  - `command.ack`: 하드웨어 ACK 수신 완료 (`ACKED` / `PARTIAL`)
  - `command.timeout`: 15초 미응답 타임아웃

---

## 6. 상태 머신 및 핵심 용어 정의 (State Machine)

### 6.1 Hanger State Definitions
| State Enum | 한국어 표준 표기 | 기술적 발생 조건 및 의미 |
|---|---|---|
| **`PRESENT`** | **`옷 감지됨`** | 유효한 등록 태그가 감지되어 정상 거치 중 |
| **`EMPTY`** | **`비어 있음`** | 옷걸이에 아무런 NFC 태그도 감지되지 않음 |
| **`UNKNOWN_TAG`** | **`미등록 옷 태그`** | NFC 태그가 감지되었으나 의류 DB에 등록되지 않은 태그임 (새 옷 등록 대상) |
| **`CONFLICT`** | **`중복 감지`** | 동일한 NFC UID가 2개 이상의 서로 다른 옷걸이에서 동시에 보고됨 |
| **`UNSTABLE`** | **`인식 불안정`** | NFC 판독 노이즈 또는 흔들림 발생 상태 |
| **`OFFLINE`** | **`연결 끊김`** | 30초(`OFFLINE_TIMEOUT_MS`) 이상 Heartbeat 패킷 미수신 |

### 6.2 Garment State Definitions
| State Enum | 한국어 표준 표기 | 의미 |
|---|---|---|
| **`IN_WARDROBE`** | **`옷장 안`** | 옷걸이(`currentHanger`)에 정상 거치되어 보관 중 |
| **`OUT`** | **`옷장 밖`** | 옷걸이에서 분리되어 착용 또는 세탁 중 (`currentHanger: null`) |

### 6.3 Command State & ACK 의미 원칙
| State Enum | 한국어 표준 표기 | 수명주기 및 의미 |
|---|---|---|
| **`QUEUED`** | **`찾기 요청됨`** | 사용자가 명령을 생성하여 백엔드 큐에 대기 중 |
| **`SENT`** | **`찾기 명령 전달됨`** | 게이트웨이가 폴링하여 ESP-NOW로 방출한 상태 |
| **`ACKED`** | **`LED 점멸 시작됨`** | 옷걸이가 명령을 수신하여 점멸을 시작함 (*"찾기 완료"가 아님*) |
| **`TIMEOUT`** | **`응답 시간 초과`** | 15초 내 하드웨어 ACK 미수신으로 만료 |

---

## 7. 가상 하드웨어 시뮬레이터 (Virtual Hardware Architecture)

### 7.1 시뮬레이션의 경계 (What is Real vs What is Virtual)
- **100% Real (실제와 동일한 구간)**:
  - Node.js 백엔드 REST API 및 WebSocket 엔진
  - Reconcile 로직 및 데이터 영속화(`wardrobe.json`)
  - HTTP 인증(Device Token / User JWT) 및 프로토콜 검증
  - 웹/모바일 클라이언트 UI 및 실시간 이벤트 핸들러
- **Virtual (모사 구간)**:
  - ESP-NOW 무선 RF 채널 및 물리적 NFC 태그 접촉
  - Node.js 기반 `VirtualGateway`와 `VirtualHanger` 클래스가 물리적 펌웨어의 패킷 생성, 시퀀스 번호 증가, 부트 ID 관리, ACK 응답 지연(50ms) 및 하트비트 전송을 100% 정확하게 모사합니다.

### 7.2 서버 재시작 시 시뮬레이션 상태 복원 메커니즘
- **물리 하드웨어의 실제 동작**: 서버가 재시작되어도 옷걸이는 옷봉에 그대로 걸려 있으므로, C6가 계속해서 현재 상태(`state: PRESENT, tagUid: 04A1...`)를 전송하여 서버 부팅 즉시 `IN_WARDROBE`가 복원됩니다.
- **가상 하드웨어 복원**: 개발 환경에서 서버 프로세스 재시작 시 옷걸이 거치 상태가 유실되지 않도록, `VirtualGateway`는 `data/simulator-state.json`에 자신의 가상 물리 상태를 저장/로드하며, 부팅 즉시 백엔드에 초기 상태를 재보고하여 완벽한 복원을 구현합니다.

---

## 8. 스마트 코디 추천 엔진 ([`shared/recommendation.js`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/shared/recommendation.js))

- **독립 모듈화**: DOM에 의존하지 않는 Universal JS 모듈 (Node.js & Mobile/Browser 양용).
- **점수 정규화 (0 ~ 100점)**: 내부 순위 계산용 `rawScore`를 사용자 친화적인 0 ~ 100점 만점 점수(`displayScore`)로 변환.
- **날씨 연동 (Open-Meteo)**: 무료 비상업 API (일 10,000건 한도)를 20분 로컬 캐싱하여 사용하며, 네트워크 장애 시 **Local Rule-based Fallback**으로 무중단 추천 보장.
- **상황별 가중치**: 비즈니스(셔츠/슬랙스/자켓), 캠퍼스(후드/데님), 데이트(니트/코트), 운동(트레이닝) 가중치 적용.
- **대화형 어시스턴트**: 외부 LLM 키 없이도 실물 옷장 인벤토리(`IN_WARDROBE`)를 바탕으로 자연어 인텐트를 분석하여 추천 및 1-Click FIND 제공.

---

## 9. 검증 상태 요약 (Software Verification Status)

- **소프트웨어 자동화 테스트 (`npm test`)**: **17개 전체 시나리오 100% PASS**
  - Scenario A ~ I: 태그 삽입/제거, 미등록 태그, 중복 시퀀스 차단, CONFLICT 감지, FIND-ACK, 타임아웃, WebSocket 실시간 브로드캐스트, 의류 삭제
  - Scenario J ~ L: Persistent FIND (durationMs=0), LED STOP (LED_OFF 즉시 소등), 다중 코디 동시 점멸/소등
  - Scenario M: 코디 추천 엔진 (0~100점 정규화, 한글 초성 검색, 단일 옷 랭킹, 챗봇)
  - Scenario N: 빈 옷걸이 물리 수명주기(A, B, C, D) 및 로그아웃/로그인 데이터 영속성
  - 암호화 및 UID 정규화 단위 테스트

---

## 10. 실물 하드웨어 테스트 필요 항목 (REQUIRES_PHYSICAL_TEST)

다음 항목들은 실물 부품 도착 후 실제 하드웨어 벤치에서 검증되어야 합니다:
1. **NFC 물리 감지 거리 및 공간적 선택성**:
   - PN532/NTAG213의 실제 감지거리는 기구 형상, 태그 부착 방향, 옷감 두께에 따라 달라지므로 **1차 Prototype 기구물에서는 약 1cm 전후(안정 영역 0.5~2cm)**를 시작점으로 합니다.
   - 최종 감지 거리 및 인접 옷걸이 오인식(Cross-Talk) 차단 임계값은 [`docs/PHYSICAL_INTEGRATION_PLAN.md`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/docs/PHYSICAL_INTEGRATION_PLAN.md)의 8단계 정밀 실측 절차로 결정합니다.
2. **옷봉(파워 레일) 접점 안정성**: 접점의 전원 노이즈 및 물리 탈착 시 C6 부팅 및 자동 재보고 복원력.
3. **무선 링크 신뢰성**: 2.4GHz ESP-NOW의 금속 옷장 환경 전파 감쇄 및 실측 RSSI (목표 > -75dBm).
4. **타임아웃 체감 최적화**: 실제 30초 `OFFLINE_TIMEOUT`과 옷걸이 탈착 감지 사이의 사용자 체감 딜레이 최적화.
