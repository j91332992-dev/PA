# 클라우드·실장비 최종 인수인계 (2026-08-23)

## 한 줄 상태

코드, Supabase PostgreSQL, Render 웹 서비스, C3 옷봉 및 C6 옷걸이 펌웨어까지 준비되어 있다. 현재 실제 클라우드 태그 전송을 막는 항목은 **Render `DEVICE_TOKEN`과 C3 장비 토큰의 불일치(HTTP 401)** 하나이며, 공개 Render 웹은 아직 이전 로그인 화면 JavaScript를 서비스하고 있어 최신 커밋 재배포가 필요하다.

## 완료된 내용

- 계정별 데이터 격리
  - 한 PostgreSQL 데이터베이스 안에서 `wardrobe_id`로 사용자별 옷, 옷봉, 옷걸이, 이벤트, 명령을 분리한다.
  - 다른 계정은 서로의 옷·장비·명령을 조회하거나 수정할 수 없다.
  - `npm test` 25개 전체 통과로 격리와 장비 흐름을 확인했다.
- 클라우드 저장소
  - Supabase PostgreSQL 스키마 생성과 기존 `data/wardrobe.json`의 1회 이관을 완료했다.
  - Render `/api/health`는 HTTP 200 및 `storage: "postgres"`를 반환했다.
- 웹 사용자 흐름
  - 실사용 화면에서 시뮬레이션 메뉴를 제거했다.
  - 로그인 성공 뒤 새로고침에 의존하지 않고 `/api/snapshot`을 불러온 뒤 대시보드로 전환하도록 수정했다.
  - 옷봉/옷걸이는 BLE에서 각각 `새 옷봉`, `새 옷걸이`로 시작하고, 등록 뒤 사용자의 이름 기반 표시 이름을 사용한다.
  - 설정/진단의 중복 연결 상태 카드를 제거하고 `내 장비 관리`에 통합했다.
- 펌웨어
  - C3 옷봉(ESP32-S3, COM19)에 최신 이미지를 업로드하고 플래시 검증을 통과했다.
  - C6 옷걸이(ESP32-C6, COM21)에 최신 이미지를 업로드하고 플래시 검증을 통과했다.
  - C6은 PN532 SPI로 NTAG UID를 읽고 ESP-NOW로 옷봉에 전달한다. PN532는 C6에만 필요하다.
  - C3은 구형 `http://` 서버 주소가 남아 있으면 최신 HTTPS 기본 주소로 자동 교체하고, 전원 재시작 때 TLS용 시간을 동기화한다.
  - 실제 로그에서 C3의 Wi-Fi 자동 재연결과 C6 ESP-NOW 패킷 수신을 확인했다.

## 현재 막힌 두 가지와 조치

### 1. 공개 웹 로그인 뒤 화면 전환

소스 수정 커밋은 GitHub에 올라가 있지만, 아래 Render 주소가 아직 이전 `app.js`를 제공 중이다.

`https://smart-wardrobe-api-dhb4.onrender.com`

**조치:** Render Dashboard → `smart-wardrobe-api` → **Manual Deploy** → 최신 커밋 배포를 실행한다. 배포 완료 뒤 브라우저에서 강력 새로고침(Ctrl+F5) 후 로그인한다.

최신 로그인 수정은 `5fb04e9`에 포함되어 있으며, 로그인 성공 후에는 새로고침 대신 대시보드를 바로 표시한다. 만약 snapshot 요청이 실패하면 로그인 화면에 한국어 오류 문구가 표시된다.

### 2. 실제 옷봉의 클라우드 업로드

최신 C3 로그는 다음 순서까지 성공했다.

1. 2.4 GHz Wi-Fi 연결 성공
2. Render HTTPS 인증서 검증 성공
3. C6 ESP-NOW 패킷 수신 성공
4. Render API가 `HTTP 401` 반환

따라서 Wi-Fi, ESP-NOW, 인증서, 서버 주소는 원인이 아니다. C3 `firmware/gateway/include/config.h`의 `DEVICE_TOKEN`과 Render Environment의 `DEVICE_TOKEN`을 **같은 비밀값**으로 맞춰야 한다. 비밀값은 Git, 문서, 채팅, 로그에 기록하지 않는다.

**조치:** Render Dashboard → `smart-wardrobe-api` → Environment → `DEVICE_TOKEN`을 C3에 설정한 값과 같게 수정 → Save, rebuild, deploy. 이후 옷봉은 재부팅 없이 다음 heartbeat부터 재시도하지만, 전원을 한 번 껐다 켜서 로그를 확인하는 것을 권장한다.

성공 기준은 C3 로그의 `[CLOUD] ... OK` 및 Render 설정/진단 화면의 `옷봉 연결됨`이다.

## 운영 동작 원칙

- 노트북을 꺼도 Render 서버와 Supabase DB는 계속 별도로 동작한다. 친구가 다른 지역/네트워크에서 웹에 로그인해도 자신의 데이터가 보인다.
- Render 무료 서비스는 일정 시간 요청이 없으면 잠들 수 있다. 로그인과 무관하며, 첫 요청으로 자동 기동된다. 깨어나는 첫 요청은 약 50초 이상 걸릴 수 있다.
- 옷봉 전원을 뺐다가 켜면 저장된 Wi-Fi로 자동 재연결하고, ESP-NOW 수신과 서버 heartbeat를 다시 시작한다. 서버 인증 토큰이 일치해야 클라우드 반영까지 성공한다.
- 서버 상태는 Render Dashboard의 **Events / Logs**와 `GET /api/health`에서 확인한다. `storage: "postgres"`는 클라우드 DB 연결을 뜻한다.

## 로컬 서버로 실제 태그 시험하기

클라우드와 별개로 로컬에서도 실장비 시험이 가능하다.

1. 이 feature 기반 브랜치를 내려받는다.
2. 프로젝트 루트에서 `npm start`를 실행한다.
3. PC와 C3을 같은 내부망에 둔다.
4. C3의 `config.h`/BLE 설정 서버 주소를 `http://<PC의-LAN-IP>:8787`로 바꾸고, 로컬 서버의 장비 토큰과 동일하게 맞춘다. 로컬 HTTP 시험일 때만 `ALLOW_INSECURE_HTTP`를 `1`로 설정한다.
5. C3 펌웨어를 다시 업로드하고 C6에는 PN532를 연결한 최신 펌웨어를 사용한다.
6. 브라우저에서 `http://localhost:8787`을 열고 로그인한 뒤 NTAG를 PN532에 댄다.

로컬 서버는 노트북을 끄면 중단된다. 친구 테스트·외부 접속에는 Render 공개 주소를 사용한다.

## Git 기록

이 인수인계 브랜치는 기존 기능 브랜치에 문서를 추가하지 않기 위해 별도로 만들었다.

- 기능 브랜치: `feat/real-hardware-nfc-ble-photo-ai`
- 인수인계 브랜치: `docs/final-cloud-hardware-handoff-20260823`
- 핵심 커밋:
  - `5fb04e9` 로그인 후 대시보드 전환 안정화
  - `06d7b28` 옷봉 구형 서버 주소와 HTTPS 시간 동기화 복구
  - `3bf5c0f` 옷봉 HTTPS 연결 진단 보강

## 다음 검증 순서

1. Render 최신 커밋 수동 배포
2. 공개 URL에서 로그인 → 대시보드 전환 확인
3. Render/C3 `DEVICE_TOKEN` 일치
4. C3 전원 재시작 → C3 로그에서 `[CLOUD] ... OK` 확인
5. C6 PN532에 NTAG 부착/제거 → 공개 웹 상태가 즉시 변경되는지 확인
6. 별도 계정으로 로그인 → 기존 계정의 옷·장비가 보이지 않는지 확인

## 남은 제품화 항목

- 사진 파일은 현재 로컬 `data/garment-images/`에만 있으므로, 공개 앱에서 영구 사진을 쓰려면 Supabase Storage 이전이 필요하다.
- Render 무료의 sleep/cold-start는 베타 테스트에는 가능하지만, 실판매 서비스에는 항상 켜진 유료 서비스 또는 별도 서버가 필요하다.
- 모바일 앱은 `docs/MOBILE_APP_HANDOFF.md`의 REST API와 WebSocket 계약을 그대로 사용하면 된다.
