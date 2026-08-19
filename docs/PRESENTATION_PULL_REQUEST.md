# PR: 8분 HTML 발표 덱 및 발표 대본 추가

## 요약

최신 8분 발표 대본을 기준으로 발표용 HTML 슬라이드 덱을 새로 구성했습니다. 기존 프로젝트 기능과 분리된 발표 전용 구조이며, 영상과 실제 앱이 완성되면 URL 또는 파일만 연결해 바로 사용할 수 있습니다.

## 주요 변경사항

- `docs/PRESENTATION_SCRIPT_8MIN.md` 추가
  - 오프닝 훅부터 문제정의, 시장·고객분석, 시스템 설명, 라이브 시연, 검증과 마무리까지 8분 발표 대본 작성
  - 발표자 이름, 실제 설문 수치, 영상 파일만 교체할 수 있도록 표시
- `web/public/presentation/`에 15장 슬라이드 덱 추가
  - 16:9 브라우저 전체화면 발표 지원
  - `← / →`, `PageUp / PageDown`, `F`, `O` 단축키 지원
  - 목차 패널과 슬라이드 진행률 표시
  - Pretendard/Noto Sans KR 우선의 밝은 블루 디자인 시스템
- 애니메이션·시각화 추가
  - GSAP과 anime.js 기반 슬라이드 전환 및 강조 애니메이션
  - Three.js 기반 삼각형 스마트 옷걸이 3D 모델
  - NFC UID → PN532 → ESP32-C6 → ESP-NOW → Gateway → Web/PWA 흐름 시각화
- 영상 교체 슬롯 추가
  - 1번 슬라이드: 아침에 옷을 찾다가 늦는 영상
  - 14번 슬라이드: 사용 후기·실물 검증 영상
  - `data-video-src` 값만 바꾸면 연결 가능
- 라이브 데모 슬롯 추가
  - 왼쪽: 스마트폰 중계 화면 iframe
  - 오른쪽: 직접 만든 앱 iframe
  - `desktop`, `mobile` URL 파라미터로 연결 가능
  - `command.queued`, `gateway.sent`, `hanger.command`, `command.ack`, `hanger.led` 이벤트 미러 지원
- 시장·고객 분석 슬라이드 추가
  - 스마트 옷장 자체 시장으로 과장하지 않고 글로벌 스마트홈 인접 시장으로 정의
  - Fortune Business Insights 자료 기준 2026년 `$180.12B`, 2034년 `$848.47B`, CAGR `21.40%` 표시
  - [출처 링크](https://www.fortunebusinessinsights.com/industry-reports/smart-home-market-101900)를 슬라이드에 포함
- 발표 수정사항 반영
  - 2번 슬라이드의 큰 `?` 장식을 큰따옴표로 변경
  - 핵심 질문을 `“ ”`로 묶어 강조
  - 라이브 데모 상단의 큰 제목 블록 제거

## 실행 방법

```text
http://localhost:8766/deck.html#slide-1
```

라이브 앱 연결 예시:

```text
http://localhost:8766/presentation/index.html?desktop=http%3A%2F%2Flocalhost%3A3000%2Fapp&mobile=http%3A%2F%2Flocalhost%3A3000%2Frelay#slide-13
```

## 테스트

- `node --test tests/presentation.test.js`
- 발표 덱 전용 테스트 6개 통과
- 15개 슬라이드의 HTML·인라인 스크립트 파싱 확인
- 로컬 정적 서버에서 발표 덱 파일과 라이브 슬라이드 HTTP 200 확인

## 발표 전 확인할 항목

- [ ] `[발표자 이름]` 교체
- [ ] 실제 설문 인원·비율과 원본 자료 연결
- [ ] 아침 상황 영상 연결
- [ ] 실제 앱·스마트폰 중계 URL 연결
- [ ] 실제 하드웨어 LED와 ACK 동작 확인
- [ ] 시장 출처 링크 또는 QR 작동 확인

