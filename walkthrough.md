# NFC 상태 전환 안정화 기록

## 변경 사항

- `firmware/hanger/src/main.cpp`
  - PN532를 초기화할 때 유한 passive-activation retry(1회)를 명시적으로 설정했다.
  - 진행 중인 `InListPassiveTarget` 응답을 회수하기 전에는 다음 스캔 명령을 보내지 않는 단일-진행 스캔 상태기로 변경했다. 이 명령 겹침이 다초 지연의 원인이었다.
  - PN532 응답 타임아웃을 즉시 태그 이탈로 처리하지 않아, 순간 I2C 글리치가 `EMPTY` 상태를 만들지 않도록 했다.
  - 100ms 스캔, 2회 연속 감지, 350ms 제거 유예를 적용했다.
  - 실제 I2C 쓰기/ACK 오류에만 재초기화를 적용하고, 재시도 사이에 2초 쿨다운을 둔다.
- `firmware/gateway/src/main.cpp`
  - HTTP 연결/응답 타임아웃을 1.2초로 설정하고, 실패 상태 코드를 시리얼에 기록한다.
  - 새 `HTTPClient`마다 stale TCP 연결을 재사용하지 않는다.
- `web/public/app.js`, `web/public/sw.js`
  - WebSocket의 `hanger.state` 수신 시 최근 이벤트 모델에도 즉시 추가하도록 수정했다.
  - 서비스 워커 캐시 버전을 올리고 즉시 활성화하여, 한 번의 강력 새로고침 후 최신 실시간 UI가 적용된다.

## 실행 및 검증

- C6(COM21) 및 S3(COM19) 펌웨어를 빌드하고 esptool로 기록했다. 플래시 SHA 검증을 통과했다.
- C6는 USB-Serial/JTAG이므로 `--before usb-reset`으로 부트로더 연결을 확인했다.
- 새 C6 이미지에서 PN532 `READY`, firmware `0x32010607`, passive retry `1`을 시리얼로 확인했다.
- Node 서버 health endpoint는 HTTP 200이며, S3의 상태 업로드는 관찰된 사례에서 수백 ms 이내에 완료됐다.

## 남은 물리 검증

- 새 단일-진행 스캔 상태기로 실물 카드의 올림/제거 각각 한 번을 측정해야 한다. 목표는 C6 상태 전환부터 웹 반영까지 1초 이내다.
- UI 변경은 현재 열린 탭에 자동 주입되지 않으므로, 첫 적용 때만 `Ctrl+F5`가 필요하다. 이후 최근 이벤트는 WebSocket으로 새로고침 없이 갱신된다.

## 옷 사진 자동 처리 추가

- `tools/background-removal-demo/server.py`는 이 PC에서만 실행되는 사진 처리 서비스다. 업로드한 JPG/PNG/WEBP(12MB 이하)에서 배경을 투명 PNG로 제거하고, 옷의 종류·색상·계절을 추천한다.
- `backend/garment-image-service.js`는 웹 로그인 사용자의 사진 요청만 이 서비스로 전달하고, 처리된 사진은 `data/garment-images/`에 보관한다. NFC/BLE/ESP-NOW 통신 경로에는 변경이 없다.
- 옷 등록 창에서 **사진 선택**을 누르면 배경 제거 결과가 미리 보기로 바뀌고, 자동 추천값은 기존 옷 등록 항목에 채워진다. 추천값은 사용자가 수정할 수 있다.
- Python AI 패키지는 OneDrive 동기화 문제를 피하기 위해 `%LOCALAPPDATA%\\SmartWardrobe\\garment-ai\\.venv`에 설치한다. 처음 사진을 처리할 때만 모델 다운로드와 준비로 시간이 더 걸릴 수 있다.

## 사진 기능 검증

- Node 문법 검사(`backend/server.js`, `backend/garment-image-service.js`, `web/public/app.js`)와 Python 문법 검사를 통과했다.
- Python 사진 서비스의 `/api/health`가 200으로 응답하는 것을 확인했다.

## 계정별 옷장·실장비 관리

- `backend/server-v3.js`는 기존 단일 JSON 데이터를 `사용자 → 개인 옷장 → 옷봉/옷걸이/옷/이벤트/명령` 구조로 자동 마이그레이션한다. 로그인한 계정에는 자기 옷장 데이터와 WebSocket 이벤트만 전송된다.
- `backend/storage.js`는 기본 로컬 JSON 모드를 유지하면서 `DATABASE_URL`이 설정된 경우 Supabase PostgreSQL 저장소로 전환한다. `scripts/migrate-json-to-postgres.js`는 비어 있는 클라우드 DB에만 기존 JSON을 1회 이관한다.
- `render.yaml`, `supabase/schema.sql`, `docs/CLOUD_BETA_DEPLOYMENT.md`는 친구 테스트용 Render/Supabase 배포 절차를 제공한다. 공개 배포에서는 C3 옷봉도 HTTPS와 배포 도메인의 공개 루트 CA를 사용해야 한다.
- 기존 실장비가 마지막으로 `EMPTY`여서 NFC UID로 소유자를 알 수 없는 경우에는, 기존 옷을 가장 많이 등록한 계정에만 한 번 귀속한다. 이 프로젝트의 `GW-D4DB1C` 옷봉과 `HC-62F2A0` 옷걸이는 해당 규칙으로 함께 보존됐다.
- 새 C6는 현재 펌웨어를 업로드한 뒤 옷봉에 ESP-NOW로 연결하면 된다. 웹의 **설정/진단 → 내 장비 관리**에서 옷봉과 옷걸이를 각각 보고, 이름 수정 또는 내 계정에서만 등록 제거할 수 있다.
- 실사용 서버에서는 시뮬레이션을 기본 비활성화했고, 웹 메뉴·가상 장비 필터를 제거했다. 시뮬레이터는 테스트에서만 `SIMULATION_ENABLED=true`로 켠다.

## 계정 분리 검증

- `npm test` 실행 결과: 24개 테스트 모두 통과.
- 새 `tests/tenant-isolation.test.js`는 두 계정이 같은 NFC UID를 각자 등록할 수 있고, 다른 계정의 옷·옷봉·옷걸이·LED 명령에 접근할 수 없음을 확인한다.
- 로컬 서버를 새 버전으로 다시 기동했고 `http://localhost:8787/api/health`가 HTTP 200, `simulationEnabled:false`를 반환했다.
- 실제 인물/의류 사진 1장으로 첫 모델 다운로드 후 배경 제거·분류 결과를 확인하면 최종 체감 검증이 끝난다.

## 클라우드 이관 저장 안정화

- PostgreSQL 전체 스냅샷 저장은 이제 요청 순서대로 하나씩만 실행된다. 초기 이관, 장비 상태 변경, 오프라인 감지 타이머가 겹쳐도 동일 사용자 ID를 두 번 삽입하지 않는다.
- `scripts/migrate-json-to-postgres.js`는 이관 중 실시간 장비/오프라인 타이머를 시작하지 않는다. 이관이 끝난 뒤 저장 대기열까지 마무리하고 DB 연결을 닫는다.
- `npm test` 결과: 25개 테스트 모두 통과.
- Render 배포 진입점은 `0.0.0.0:$PORT`에 명시적으로 바인딩해, Render의 HTTP 포트 감지가 환경별 Node 기본 바인딩에 좌우되지 않도록 했다.

## 사용자용 장비 연결 흐름

- 설정/진단 화면의 중복된 옷봉·옷걸이 상태 카드를 제거하고 **내 장비 관리** 한 곳에서 연결 상태, 이름 수정, 등록 제거를 관리하도록 통합했다.
- 옷봉 인터넷 연결은 **처음 한 번만** 2.4 GHz Wi-Fi를 저장하는 흐름으로 바꿨다. PC·휴대폰 Wi-Fi를 바꾸지 않으며, 공개 웹 주소는 자동으로 옷봉에 전달된다.
- 옷봉 BLE 이름은 `새 옷봉`에서 시작해 저장 후 `사용자 이름의 옷봉`이 되고, 옷걸이는 `새 옷걸이`에서 시작해 등록 후 `사용자 이름의 옷걸이 1번` 형식이 된다.
- 옷봉은 BLE 상태로 `2.4 GHz Wi-Fi 미발견`, `Wi-Fi 비밀번호 인증 실패`, `Wi-Fi 연결 실패`, `서버 등록 정보 오류`, `서버 연결 실패`를 구분해 안내한다.
- 화면과 BLE 상태에서 PN532/NTAG 같은 부품명 대신 `옷 태그 읽기`와 `옷 태그`라는 사용자용 표현을 사용한다. 진단용 식별자는 일반 화면에서 숨긴다.

## 남은 물리 적용

- 공개 Render 서버를 사용하는 옷봉에는 최신 S3 펌웨어를 업로드해야 한다. 이때 서버 URL은 HTTPS 공개 주소여야 하며, Render의 `DEVICE_TOKEN`과 옷봉의 장비 토큰은 같은 값이어야 한다. 이 값은 소스·로그·채팅에 기록하지 않는다.
- 기존 옷 사진 파일은 PC의 `data/garment-images/`에만 있고 Render 파일 시스템에는 없으므로, 공개 웹에서 영구 사진을 보이게 하려면 다음 단계로 Supabase Storage 이전이 필요하다. 데이터베이스 이관과는 별개다.

## 로그인 초기화 회귀 복구

- `web/public/hanger-freshness.js`를 브라우저 정적 루트로 제공하도록 이동했다. 이전에는 `/hanger-freshness.js` 요청이 `index.html` fallback을 받아 `Unexpected token '<'`가 발생했고, 그 결과 `app.js` 초기화와 로그인 submit 핸들러가 중단됐다.
- `web/public/app.js`는 인증 폼을 명시적으로 POST로 설정하고 submit 버튼 타입을 지정한다. 기존 `preventDefault()` 및 `/api/auth/login`·`/api/auth/signup` POST 흐름은 유지된다.
- `tests/login-regression.test.js`에서 helper의 HTTP 200/JavaScript MIME/createTracker, 로그인 POST 성공, 네이티브 GET 방지 조건을 검증한다.
- 검증 결과: `npm test` 31개 통과, Node 문법 검사 및 `git diff --check` 통과.

## freshness tracker 브라우저 API 회귀 복구

- `app.js`는 `createTracker()`가 반환한 인스턴스에서 `hangerIdOf`, `clothingStatus`, `isFresher`, `remember`를 함께 사용한다. tracker가 상태 메서드만 반환하던 불일치를 수정해 브라우저와 Node 양쪽에서 동일한 API를 제공한다.
- 로그인 후 `/api/snapshot` 로드와 `mergeSnapshot()` 진입, `#auth` 숨김 및 `#app` 표시 조건을 회귀 테스트에 포함했다.
