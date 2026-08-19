# PA Smart Wardrobe — Mobile App Developer Handoff Master Guide

> 📌 **수신자**: 성준 (Mobile App 담당 개발자)  
> 📌 **작성자**: 정운 (Server / System 담당 개발자)  
> 📌 **최종 갱신일**: 2026-08-19  
> 📌 **상태**: Backend SW 검증 완료 (v1.2.0)

---

## 1. Handoff 핵심 요약 (Executive Summary)

1. **Web Reference vs Mobile App의 역할 정의**:
   - 현재 `web/public`의 Web UI는 **Reference / Test / Developer Client**입니다.
   - **성준 님이 개발하는 Mobile App(Flutter 또는 React Native)이 최종 사용자가 실제로 사용하는 공식 프로덕션 클라이언트**입니다.
   - 웹 시뮬레이터 UI(하드웨어 조작 버튼 등)를 모바일 앱에 그대로 만들 필요는 없으며, **백엔드 REST API와 WebSocket 계약, 코디 추천 규칙은 100% 동일하게 사용**합니다.
2. **단일 진실 공급원 (Single Source of Truth)**:
   - 모바일 앱은 로컬에서 임의로 옷걸이/의류의 상태를 추정하거나 확정하지 않습니다.
   - 모든 상태 전환은 백엔드의 `reconcile()` 결과 및 WebSocket 이벤트 스트림에 따릅니다.
3. **지속 점멸 FIND & LED 소등 체계**:
   - `POST /api/commands` (`command: "LED_BLINK", durationMs: 0`) → 타깃 옷걸이 지속 점멸 시작.
   - `POST /api/commands` (`command: "LED_OFF"`) → 즉시 소등.
   - `ACKED` 상태는 "찾기 완료"가 아니라 **"LED 점멸 시작됨 / 찾는 중"**을 의미합니다.

---

## 2. 서버 접속 환경 (Environment & Base URL)

- **개발/로컬 테스트**: `http://<SERVER_IP>:8787` (WebSocket: `ws://<SERVER_IP>:8787/ws`)
- **인증 방식**: HTTP Bearer JWT 토큰 (`Authorization: Bearer <USER_TOKEN>`)
- **실시간 소켓**: `ws://<SERVER_IP>:8787/ws?token=<USER_TOKEN>`

---

## 3. 핵심 모바일 연동 흐름 (Step-by-Step Mobile Flow)

### Step 1. 세션 점검 및 사용자 인증 (Auth)
```text
앱 실행 
  ├── GET /api/auth/status 
  │     ├── { setupRequired: true }  ──▶ [첫 관리자 생성 화면] ──▶ POST /api/auth/signup
  │     └── { setupRequired: false } ──▶ [로그인 화면]         ──▶ POST /api/auth/login
  └── 로그인 성공 -> Token SecureStorage에 저장 -> Step 2 진행
```

### Step 2. 초기 데이터 동기화 & 실시간 WebSocket 연결
```text
1. GET /api/snapshot (또는 WebSocket 연결)
   - garments, hangers, commands, events 전체 모델 수신
2. ws://<HOST>:8787/ws?token=<USER_TOKEN> 연결
   - 수신 즉시 첫 메시지로 전체 snapshot 전송받음
   - 이후 증분 이벤트(hanger.state, command.ack 등) 실시간 반영
```

### Step 3. 하드웨어 옷걸이를 이용한 새 옷 등록 (NFC Auto-Pairing)
1. 사용자가 NFC 스티커가 붙은 새 옷을 스마트 옷걸이에 걸면, Hanger 상태가 **`UNKNOWN_TAG`**로 전환됩니다.
2. 모바일 앱의 [새 옷 등록] 화면에서 감지된 `UNKNOWN_TAG` 목록을 드롭다운에 노출합니다.
3. 사용자가 옷 이름, 분류, 색상, 계절을 입력하고 `POST /api/garments`를 호출합니다.
4. 백엔드가 `reconcile()`하여 즉시 해당 Hanger를 **`PRESENT`**, Garment를 **`IN_WARDROBE`**로 전환합니다.

### Step 4. 의류 및 코디 찾기 (Persistent FIND & LED STOP)
```json
// 1. 코디/의류 찾기 시작 (지속 점멸)
POST /api/commands HTTP/1.1
Authorization: Bearer <USER_TOKEN>
Content-Type: application/json

{
  "targets": ["HC-000001", "HC-000002"],
  "command": "LED_BLINK",
  "durationMs": 0
}
```
```json
// 2. LED 끄기 (수동 소등)
POST /api/commands HTTP/1.1
Authorization: Bearer <USER_TOKEN>
Content-Type: application/json

{
  "targets": ["HC-000001", "HC-000002"],
  "command": "LED_OFF"
}
```

---

## 4. UI 렌더링 표준 및 한국어 상태 레이블

| 상태 Enum | 모바일 앱 한국어 표기 | 색상 / 아이콘 가이드 | UI 동작 설명 |
|---|---|---|---|
| `IN_WARDROBE` | **`옷장 안`** | 🟢 Green Badge | 옷걸이에 걸려 보관 중 (FIND 가능) |
| `OUT` | **`옷장 밖`** | ⚪ Gray Badge | 옷걸이에서 분리되어 착용/세탁 중 |
| `PRESENT` | **`옷 감지됨`** | 🟢 Green Badge | 등록된 옷 태그가 감지됨 (의류명 표시) |
| `EMPTY` | **`비어 있음`** | ⚪ Light Gray | 빈 옷걸이 |
| `OFFLINE` | **`연결 끊김`** | ⚫ Dark Gray / Red | 30초 이상 신호 없음 (옷봉 분리 or RF 단절) |
| `CONFLICT` | **`중복 감지`** | 🔴 Red Badge | 동일 태그가 2개 이상 옷걸이에서 동시 감지됨 |
| `UNKNOWN_TAG` | **`미등록 옷 태그`** | 🟡 Yellow Badge | 미등록 태그 감지됨 (터치 시 [새 옷 등록] 연결) |
| `UNSTABLE` | **`인식 불안정`** | 🟠 Orange Badge | 태그 판독 노이즈 발생 |
| `QUEUED` | **`찾기 요청됨`** | 🔵 Blue Badge | 명령 대기 중 |
| `SENT` | **`명령 전달됨`** | 🔵 Blue Badge | 게이트웨이 수신 완료 |
| `ACKED` | **`LED 점멸 시작됨`** | 💡 Orange Pulse Badge | Hanger가 수신하여 점멸 중 (**"찾는 중"**) |
| `TIMEOUT` | **`응답 시간 초과`** | 🔴 Red Badge | 15초 내 미응답 |

---

## 5. 코디 추천 엔진 통합 가이드 ([`shared/recommendation.js`](file:///C:/Users/hpo20/OneDrive/바탕%20화면/Project%20List/pysical%20AI/PA/shared/recommendation.js))

### 5.1 추천 엔진 원칙
- **추천 대상**: 실제 옷장에 걸려 있는 옷(`currentState === 'IN_WARDROBE'`)만 조합.
- **점수 체계**: 0 ~ 100점 만점 (`displayScore`).
- **추천 사유**: 색상 조화(톤온톤/무채색), 계절 일치, 상황 가중치, 날씨 가중치를 1~3개 Bullet point로 제공.

### 5.2 모바일 연동 방식
1. **React Native**: `shared/recommendation.js`를 프로젝트에 복사하여 클라이언트 로컬에서 직접 실행.
2. **Flutter / Native**:
   - 방법 A: `shared/recommendation.js`의 순수 함수 로직을 Dart/Swift로 1:1 포팅.
   - 방법 B: 서버에 신설될 `POST /api/recommendations/outfit` 엔드포인트를 호출하여 JSON 수신.

### 5.3 Open-Meteo 날씨 연동 & Fallback
- **무료 API**: `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,apparent_temperature,precipitation,weather_code`
- **모바일 확장**: 모바일 기기의 GPS 위치(위도/경도)를 받아와 자동 조회.
- **캐싱 & 장애 처리**: 20분 로컬 캐싱 적용 및 네트워크 단선/API 장애 시 **Local Rule-Based Fallback**으로 무중단 추천 제공.

---

## 6. Mobile App Integration Checklist (체크리스트)

### Phase 1: 기반 인프라 & 인증
- [ ] Base URL 및 SecureStorage 토큰 저장소 구성
- [ ] `GET /api/auth/status` 기반 가입/로그인 라우팅
- [ ] `POST /api/auth/login` 및 `POST /api/auth/signup` 연동
- [ ] HTTP 401 수신 시 자동 로그아웃 및 로그인 화면 복귀

### Phase 2: 실시간 데이터 동기화
- [ ] `GET /api/snapshot` 스냅샷 스토어 초기화
- [ ] WebSocket (`/ws?token=...`) 연결 및 백그라운드 재연결 루프 (2초)
- [ ] `hanger.state`, `command.ack`, `garment.created`, `garment.deleted` 이벤트 리스너 작성

### Phase 3: 옷장 & 의류 관리 UI
- [ ] 의류 목록 화면 (이미지 없는 경우 SVG/카테고리 틴트 실루엣 Fallback 렌더링)
- [ ] 옷걸이 목록 화면 (한국어 상태 레이블 및 온라인/오프라인 배지)
- [ ] 미등록 태그(`UNKNOWN_TAG`) 감지 시 1-Touch 새 옷 등록 폼 자동 채움
- [ ] 의류 삭제 (`DELETE /api/garments/:id`) 시 Hanger가 `UNKNOWN_TAG`로 복귀하는 흐름 처리

### Phase 4: FIND & LED 제어
- [ ] 개별 옷 찾기 (`POST /api/garments/:id/find` 또는 `POST /api/commands` with `LED_BLINK, durationMs: 0`)
- [ ] LED 끄기 (`POST /api/commands` with `LED_OFF`)
- [ ] `ACKED` 수신 시 카드 테두리 점멸 및 "찾는 중" 텍스트 노출

### Phase 5: 스마트 코디 추천
- [ ] GPS 기반 Open-Meteo 실시간 날씨 위젯 연동 (20분 캐시)
- [ ] 상황 선택 드롭다운 (출근, 캠퍼스, 데이트, 운동, 데일리)
- [ ] 상·하의·아우터 맞춤 코디 Top 3 카드 및 [이 코디 찾기] (다중 타깃 동시 점멸)
- [ ] 특정 기준 옷 검색(Searchable Combobox) 및 어울리는 옷 순위 랭킹
- [ ] 대화형 코디 도우미 입력창 및 맞춤 추천 응답
