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
- 실제 인물/의류 사진 1장으로 첫 모델 다운로드 후 배경 제거·분류 결과를 확인하면 최종 체감 검증이 끝난다.
