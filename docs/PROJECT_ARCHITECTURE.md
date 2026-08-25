# PAI 프로젝트 구조와 동작 방식

이 문서는 현재 `feat/real-hardware-nfc-ble-photo-ai` 브랜치를 기준으로, 시스템의 구성과 데이터 흐름을 정리한 개발 기준 문서입니다.

## 1. 전체 구조

```text
사용자 웹/PWA
  └─ HTTP API + WebSocket
       └─ Node.js 메인 서버
            ├─ 로그인·사용자·옷장·의류·장비 관리
            ├─ NFC/옷걸이 상태 처리
            ├─ LED 찾기 명령 생성·추적
            ├─ 웹 정적 파일 제공
            ├─ JSON 또는 PostgreSQL 저장
            └─ 이미지 처리 서비스 호출

실물 장비
NTAG213 → PN532 → ESP32-C6 옷걸이
                      └─ ESP-NOW → ESP32-S3 게이트웨이
                                         └─ Wi-Fi/HTTP → Node 서버

이미지
Node 서버 → Python AI 이미지 처리 → Supabase Storage
```

현재 시스템은 Node.js 서버를 중심으로 구성된 스마트 옷장 시스템이다. 웹 애플리케이션, 장비 통신 API, 실시간 상태 갱신, 의류·계정 데이터 관리가 하나의 Node.js 애플리케이션에 모여 있다.

## 2. 주요 소스와 역할

| 위치 | 역할 |
| --- | --- |
| `backend/server.js` | 서버 실행 진입점. 실제 구현 서버를 로드하고 포트를 연다. |
| `backend/server-v3.js` | HTTP API, WebSocket, 인증, 장비·의류 상태 계산 등 핵심 비즈니스 로직. |
| `backend/storage.js` | JSON 파일 저장소와 PostgreSQL 저장소를 선택하는 데이터 접근 계층. |
| `backend/cloud-image-service.js` | Supabase 및 별도 Python 이미지 처리 서비스와 연결하는 클라우드 사진 처리 계층. |
| `backend/garment-image-service.js` | 로컬 Python 배경 제거 도구와 연결하는 로컬 사진 처리 계층. |
| `web/public/` | 별도 프론트엔드 빌드 과정 없이 서버가 직접 제공하는 PWA 정적 파일. |
| `firmware/gateway/` | XIAO ESP32-S3 게이트웨이 펌웨어. Wi-Fi와 서버 통신, ESP-NOW 중계를 담당. |
| `firmware/hanger/` | XIAO ESP32-C6 옷걸이 펌웨어. PN532 NFC 상태와 LED 제어를 담당. |
| `shared/protocol.h` | 장비 간 공유하는 통신 프로토콜 정의. |
| `shared/recommendation.js` | 의류 추천 로직. |
| `simulator/` | 실물 장비 없이 장비·NFC·명령 흐름을 검증하는 가상 하드웨어. |
| `supabase/` | PostgreSQL 스키마와 마이그레이션. |

## 3. 서버 실행 방식

`npm start`는 `node backend/server.js`를 실행한다.

1. `server.js`가 `server-v3.js`를 불러온다.
2. 서버는 프로젝트 루트의 `.env` 환경 변수를 읽는다.
3. 기본 포트 `8787`, 모든 네트워크 인터페이스(`0.0.0.0`)에서 HTTP 서버를 시작한다.
4. `web/public`을 정적 웹 파일로 제공한다.
5. API 요청과 WebSocket 연결을 같은 서버에서 처리한다.

주요 환경 변수는 다음과 같다.

| 변수 | 용도 |
| --- | --- |
| `PORT` | 서버 포트. 기본값은 `8787`. |
| `JWT_SECRET` | 사용자 로그인 토큰 서명 키. |
| `DEVICE_TOKEN` | 게이트웨이 API 인증 토큰. |
| `DATABASE_URL` | 설정하면 PostgreSQL 사용, 비어 있으면 JSON 파일 모드 사용. |
| `PUBLIC_ORIGIN` | CORS 허용 출처. |
| `ADMIN_EMAIL`, `ADMIN_SECONDARY_PASSWORD` | 관리자와 2차 인증 설정. |
| `SUPABASE_*`, `IMAGE_PROCESSOR_*` | 클라우드 사진 처리 기능 설정. |

## 4. 데이터 저장 방식

저장소는 두 가지 모드로 동작한다.

- 로컬 기본 모드: `data/wardrobe.json`에 데이터를 저장한다.
- 클라우드 모드: `DATABASE_URL`이 설정되어 있으면 PostgreSQL을 사용한다.

주요 데이터는 사용자, 옷장, 게이트웨이, 옷걸이, 의류, 이벤트, LED 명령이다. 사용자는 하나의 옷장을 가지며, 모든 장비·의류·이벤트·명령은 `wardrobeId`로 사용자별 분리된다.

## 5. 웹 애플리케이션

웹은 `web/public/index.html`, `app.js`, `style.css` 중심의 정적 PWA다. 별도의 React·Vue 빌드 서버는 없다.

- HTTP API로 로그인, 등록, 목록 조회, 명령 요청을 처리한다.
- `/ws` WebSocket으로 장비 상태와 명령 결과를 실시간 수신한다.
- 서비스 워커(`sw.js`)와 매니페스트(`manifest.json`)를 통해 PWA 기능을 제공한다.
- `recommendation.js`는 클라이언트에서 의류 추천 기능을 제공한다.

## 6. 인증과 권한

일반 로그인은 이메일과 비밀번호를 사용한다. 비밀번호는 PBKDF2 해시로 저장되며, 로그인 후 서버가 서명된 토큰을 발급한다.

- 일반 사용자: 본인 옷장 데이터와 장비만 접근한다.
- 관리자: `ADMIN_EMAIL`과 일치하는 계정에 관리자 역할이 부여된다.
- 관리자 민감 기능: 일반 로그인 외에 서버 내 2차 인증 세션이 필요하다.
- 게이트웨이: `DEVICE_TOKEN`과 게이트웨이 식별 헤더를 이용해 장비 API에 접근한다.

## 7. 핵심 API 로직

API는 `backend/server-v3.js`에 직접 구현되어 있다.

| 범주 | 대표 기능 |
| --- | --- |
| 인증 | 회원가입, 로그인, 로그인 상태, 관리자 2차 인증 |
| 사용자 화면 | 옷장 전체 상태 스냅샷 조회 |
| 의류 | NFC UID 기반 의류 등록·삭제, 의류 찾기 |
| 장비 | 게이트웨이·옷걸이 등록, 소유권 연결, 이름 변경, 연결 해제 |
| 장비 상태 | 게이트웨이 heartbeat, 옷걸이/NFC 상태 보고 |
| 명령 | LED 점멸/정지 명령 생성, 게이트웨이 명령 수신, ACK 처리 |
| 사진 | 이미지 업로드, 처리 상태 조회, 처리된 이미지 제공 |
| 관리자 | 사용자·장비 현황 조회, 잘못 귀속된 장비 복구 |

## 8. NFC와 장비 상태 흐름

```text
옷걸이: NFC 태그 삽입·제거 감지
  → ESP-NOW 패킷 전송
게이트웨이: ESP-NOW 패킷 수신
  → POST /api/gateway/status
서버: 장비·의류 상태 계산 및 저장
  → WebSocket 이벤트 전송
웹: 화면 즉시 갱신
```

서버는 NFC UID와 등록된 의류를 연결해 의류 상태를 계산한다. 대표 상태는 다음과 같다.

- `IN_WARDROBE`: 등록된 의류가 옷걸이에 감지됨
- `OUT`: 의류가 현재 옷장에 없음
- `UNKNOWN_TAG`: 등록되지 않은 NFC 태그가 감지됨
- `CONFLICT`: 동일 태그가 여러 옷걸이에서 동시에 보고됨
- `OFFLINE`: 일정 시간 장비 상태 보고가 없었음

## 9. 의류 찾기와 LED 명령 흐름

```text
웹에서 의류 찾기 요청
  → POST /api/commands
서버: QUEUED 명령 생성
  → 게이트웨이가 GET /api/gateway/commands 로 명령 조회
게이트웨이: ESP-NOW로 해당 옷걸이에 LED 명령 전송
  → 옷걸이가 ACK 생성
  → POST /api/gateway/ack
서버: ACKED, PARTIAL, TIMEOUT 등의 상태로 갱신
  → WebSocket으로 웹 화면 갱신
```

명령은 LED 점멸(`LED_BLINK`)과 LED 정지(`LED_OFF`)를 지원한다. 중복 또는 오래된 명령은 취소·시간 초과 처리한다.

## 10. 이미지 처리

로컬 모드에서는 Node.js가 `tools/background-removal-demo`의 Python 도구를 사용한다. 이 도구는 `rembg`, `torch`, `transformers` 등을 통해 배경 제거 및 의류 사진 처리를 수행한다.

클라우드 모드에서는 Node.js API와 Python 이미지 처리 서비스가 분리된다.

```text
웹 사진 업로드
  → Node API
  → Supabase Storage에 원본 저장
  → Python image-processor에 처리 요청
  → 처리된 이미지 저장
  → 의류 데이터의 사진 상태 갱신
```

클라우드 이미지 처리는 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `IMAGE_PROCESSOR_URL`, `IMAGE_PROCESSOR_TOKEN`이 모두 설정되어야 활성화된다.

## 11. 배포 구조

`render.yaml`은 Render에 다음 두 서비스를 배포하도록 정의한다.

| 서비스 | 런타임 | 역할 |
| --- | --- | --- |
| `smart-wardrobe-api` | Node.js | API, WebSocket, 웹 화면 제공 |
| `smart-wardrobe-image-processor` | Python | 사진 배경 제거 및 이미지 처리 |

Supabase는 PostgreSQL과 의류 사진 Storage 버킷(`garments`) 용도로 사용한다.

## 12. 펌웨어와 시뮬레이터

- `firmware/gateway`: ESP32-S3 게이트웨이. Wi-Fi 설정, 서버 heartbeat, 명령 polling, ESP-NOW 중계.
- `firmware/hanger`: ESP32-C6 옷걸이. PN532 NFC 감지, LED 제어, ESP-NOW 상태 전송.
- `firmware/*-probe`: PN532·SPI·Wi-Fi 점검용 독립 펌웨어.
- `simulator/virtual-hardware.js`: 실제 장비 대신 상태와 ACK를 재현한다.
- `simulator/index.js`: 시뮬레이션 실행 진입점.

## 13. 테스트

`npm test`는 Node.js 기본 테스트 러너로 실행된다. 현재 테스트 범위는 인증, 사용자 데이터 분리, NFC 상태 변화, 명령과 ACK, WebSocket 동기화, 관리자 권한, 시뮬레이터 시나리오, 사진 업로드 파서, 추천 로직이다.

## 14. 현재 구조의 개편 포인트

현재는 빠르게 기능을 구현하기 좋은 구조이지만, 핵심 로직이 `backend/server-v3.js` 하나에 집중되어 있다. 기능을 크게 확장할 계획이라면 아래와 같이 역할을 분리하는 방식을 권장한다.

```text
backend/
  routes/         HTTP 주소와 요청·응답 처리
  services/       인증·의류·장비·명령 비즈니스 로직
  repositories/   JSON/PostgreSQL 데이터 접근
  realtime/       WebSocket 이벤트 발행과 구독
  middleware/     인증·권한·입력 검증
  server.js       애플리케이션 조립과 실행
```

다만 작은 기능 변경은 기존 구조에서 안전하게 진행할 수 있다. 요구사항을 보낼 때 기능 목표, 변경할 화면 또는 사용자 흐름, 실물 장비 영향 여부, 기존 데이터 유지 여부를 알려 주면 가장 정확하게 구현할 수 있다.
