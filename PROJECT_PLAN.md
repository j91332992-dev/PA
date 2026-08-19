# 스마트 옷장 프로젝트 수행 계획
## PRD v2 + 7일 실행 로드맵

### 0. 문서 개요
- **목적**: Smart Wardrobe Master PRD v2 + 우리 팀 4명 + 7일 일정 통합
- **버전**: v1.0
- **적용 기간**: 7일 (Day 0 ~ Day 7)
- **최종 결과**: 실물 + 배포된 서비스 + 라이브 시연 + 웹 발표

---

## 1. 프로젝트 수행 방향

본 프로젝트는 **NFC ↔ Hanger ↔ Gateway ↔ Cloud ↔ Web/PWA**를 실제 서비스 형태로 연결하는 것을 목표로 한다.

### 진행 순서
```
 HW 설계 → SW/통신 → Web/App → 실제 테스트 → 디자인/기능 개선
```

### 도구 활용 (AI 보조)
- **OpenCode**: UI, 펌웨어, 백엔드 코드 보조
- **PlatformIO / Arduino IDE**: ESP32 펌웨어
- **Figma / Canva**: 디자인, 발표 자료
- **DaVinci Resolve**: 영상 편집
- **Voice Memos / OBS**: 시연 녹화

### 최종 산출물
- 실물 스마트 옷걸이 + 옷봉 + Gateway
- Firmware + Cloud DB + Web/PWA + Smartphone 연계
- 3D 모델 + 시연 영상 + Web Slide + Live Demo

---

## 2. 역할 분담 (4명)

### A — SW / 통신 / 시스템 통합 (친구)
**주요 작업**
- Gateway 펌웨어 (XIAO ESP32-S3)
- ESP-NOW 수신 (Hanger → Gateway)
- Backend (FastAPI + SQLite)
- WebSocket (실시간 푸시)
- 1차 Web/PWA (백엔드 API)
- Hanger ↔ Gateway 통신
- 전체 기능 검사

**작업 Flow**
```
 Hanger → ESP-NOW → Gateway → WiFi → Backend → DB → WebSocket → Web
```

**사용 도구**
- PlatformIO / Arduino IDE
- Python / FastAPI
- SQLite
- WiFiManager (자동 재연결 라이브러리)

---

### B — HW / 기구 / 3D 설계 (Person 1)
**주요 작업**
- 실제 부품 치수 측정
- 스마트 옷걸이 / 케이스 / Holder / Jig 제작
- 3D 프린팅 (케이스)
- Pogo 접촉 구조
- 자석 정렬 (회전 정렬)
- NFC 간섭 확인
- HW ↔ SW 통합 디버깅
- 발표용 3D 모델

**작업 Flow**
```
 실물 측정 → Fusion 설계 → 3D Print → 조립 → 테스트 → 수정
```

**사용 도구**
- Fusion 360 (CAD)
- 인두기, 핫글루
- 폼보드 (임시 케이스)
- 멀티미터

---

### C — Web/App / 디자인 (너)
**주요 작업**
- 1차 Web 디자인 (옷장 페이지)
- 옷장 페이지 + 옷 추가 모달 + 찾기 UI
- Backend API 연결 (fetch)
- WebSocket 실시간 업데이트
- PWA 설정
- 시연 영상 촬영
- 발표 시각자료

**작업 Flow**
```
 PRD V2 → OpenCode → 옷장 + 모달 + 찾기 → Backend 연동 → 모바일 테스트
```

**사용 도구**
- OpenCode (코드 보조)
- Chrome DevTools (디버깅)
- HTML/CSS/JavaScript
- WebSocket API

---

### D — 발표 / Web Slide / 발표 총괄 (모두)
**주요 작업**
- 발표 Story 구성
- Web Slide 제작 (HTML)
- 실제 Web App 임베드 (iframe)
- Live Demo 구성
- 발표 리허설 (3회)
- 실제 발표 (Day 7)

**작업 Flow**
```
 자료 수집 → Story → Scene → HTML 슬라이드 → Live Demo → 리허설
```

**사용 도구**
- OpenCode (슬라이드 생성)
- Reveal.js (슬라이드 라이브러리)
- GitHub (산출물 관리)

---

## 3. 공동 작업

### A + B (SW + HW)
- 봉 + 동박 + 전선 + USB-C 조립
- Pogo 접촉 ↔ 동박 전기적 검증
- NFC 통신 (PN532 ↔ NTAG213) 테스트
- HW/SW 통합 디버깅

### B + C + D (HW + Web + 발표)
- 실제 시연용 3D 모델 → 영상 → Web Slide
- Exploded View (분해도) 애니메이션

### A + B + C + D (전체)
- 기능 아이디어 회의
- 실제 사용 → 문제 발견 → 담당 배정 → 수정 → 재시험
- 매일 10분 standup (오전 10:00)

---

## 4. 7일 단계별 수행 계획

### 🚩 1단계 — HW 실측 / 3D 설계 (Day 1)
**담당**: B 중심 / A 지원

**작업**
- 부품 실측 (PN532, XIAO C6, 포고핀, 자석)
- Fusion 360에서 3D 초안 (옷걸이 케이스 + 하우징)
- 3D 모델 출력 큐빅 주문 (또는 임시 폼보드)

**산출물**: 출력 가능한 3D 도면 + 사이즈 노트

---

### 🚩 2단계 — 옷봉 + 1차 Hanger 제작 (Day 1)
**담당**: A + B

**작업**
- 봉 샌딩 + 동박 2줄 부착 (V+/GND)
- 2가닥 전선 봉 내부 → USB-C 케이블로 마스터 연결
- Hanger 1개 임시 조립 (핫�루 + 폼보드)

**검증**
- Short (단락) 없음
- 5V 출력 정상
- Pogo 접촉 (옷걸이 걸 때 V+/GND 공급)
- NFC 인식 (1cm)

**산출물**: 봉 1개 + Hanger 1개 작동

---

### 🚩 3단계 — Hanger ↔ Gateway (Day 2)
**담당**: A 중심

**작업**
- PN532 단독 테스트 (시리얼 모니터로 UID 출력)
- PN532 ↔ XIAO C6 I2C 통신
- ESP-NOW 송신 (Hanger → Gateway)
- ESP-NOW 수신 (Gateway → 시리얼 확인)
- LED 명령 (FIND 수신 → 30초 점등)

**검증**
- UID 읽기 (1cm)
- ESP-NOW 송신 성공
- ACK 수신
- LED 점등

**산출물**: Hanger 1개 + Gateway 1개 펌웨어

---

### 🚩 4단계 — Cloud / Web / Smartphone (Day 2~3)
**담당**: A 중심

**작업**
- FastAPI Backend (5개 endpoint + WebSocket)
- SQLite DB 연동
- Gateway → Backend HTTPS POST
- Backend → WebSocket 푸시
- Smartphone에서 Backend 접근 (Public URL)

**검증**
- Web에서 옷 추가 → Backend → SQLite 저장
- Gateway → Backend POST → WebSocket 수신
- Smartphone에서 PUBLIC URL 접속 가능

**산출물**: Backend URL + WebSocket 작동

---

### 🚩 5단계 — Web/PWA 디자인 (Day 2~3)
**담당**: C 중심

**작업**
- 옷장 페이지 (그리드 + + 추가 + 찾기)
- 옷 추가 모달 (앨범 + 카테고리 + UID)
- Backend API 연결 (fetch)
- WebSocket 실시간 업데이트
- PWA manifest + service worker

**검증**
- 로컬에서 옷 5개 보임
- + 추가 → 그리드 실시간 반영
- 찾기 → LED 작동

**산출물**: web/public/index.html (옷장 페이지)

---

### 🚩 6단계 — Multi Hanger / 통합 (Day 4)
**담당**: A + B + C

**작업**
- Hanger 3개 제작 (동박 + 자석 + 포고핀)
- 통합 테스트 (Hanger 3개 → Gateway → Backend → Web)
- 다중 Hanger 타겟팅 (특정 Hanger만 LED)
- WebSocket 동시 푸시 (3개 Hanger 상태)

**검증**
- Packet Loss < 5%
- Latency < 100ms
- 옷 추가/제거 시 즉시 반영
- 3개 Hanger 동시 작동

**산출물**: 시연 가능 상태

---

### 🚩 7단계 — 실물 테스트 (Day 4)
**담당**: A + B + C + D

**작업**
- 반복 탈착 (옷 추가/제거 10회)
- 옷걸이 좌우 이동 (포고핀 접촉 유지)
- WiFi 변경 (공유기 전환)
- Gateway 재부팅
- Internet 단절 (오프라인 모드)
- Smartphone LTE 제어

**산출물**: 트러블 슈팅 문서

---

### 🚩 8단계 — 배포 / 자동 deploy (Day 5)
**담당**: A + C

**작업**
- Vercel (프론트) + Render (백엔드) GitHub 연결
- `.env` 환경변수 (API_URL) 설정
- main 브랜치 merge → 자동 deploy
- 백업 영상 제작 (30초)

**검증**
- Public URL 모바일 접속 가능
- 백업 영상 30초 완성

**산출물**: Public URL + 백업 영상

---

### 🚩 9단계 — 발표 자료 / Web Slide (Day 5~6)
**담당**: D 중심 / C 지원

**작업**
- HTML 슬라이드 10장 (Reveal.js)
- 발표 Story (표지 → 문제 → 솔루션 → 라이브 데모 → 트러블 → 향후)
- 시연 영상 임베드 (iframe)
- 발표 스크립트 작성

**슬라이드 구성**
1. 표지 (제목 + 팀)
2. 문제 정의 (옷장 한계)
3. 솔루션 (자동 인식)
4. 시스템 아키텍처
5. 하드웨어 (봉 + Hanger)
6. 통신 (ESP-NOW + WiFi)
7. 백엔드 (FastAPI)
8. 웹앱 (시연)
9. 트러블 슈팅 (3가지)
10. 시연 영상

**산출물**: slides/index.html

---

### 🚩 10단계 — 발표 리허설 + 최종 발표 (Day 6~7)
**담당**: A + B + C + D

**Day 6 (리허설 3회)**
- 1회: 풀 리허설, 타이머 측정
- 2회: 문제점 수정 + 백업 시나리오
- 3회: 최종 점검

**Day 7 (발표)**
- 14:00 발표 (15분)
- 발표자: C (Web)
- 시연 조작: A (Gateway)
- 백업 대기: B, D

**산출물**: 발표 완료

---

## 5. 최종 결과

### 실물
- 스마트 옷걸이 3개 + 스마트 옷봉 + Gateway

### 서비스
- Firmware + Cloud DB + Web/PWA + Smartphone 연계

### 설계/검증
- Fusion 3D Model + 통신·전원·사용성 테스트

### 발표
- 3D 제품 영상 + 실제 시연 영상 + Web Slide + Live Demo

---

## 6. 최종 Flow

```
 AI 활용 설계 → 부품 주문 → HW 제작 → 펌웨어 → 서비스화 → 
 실사용 검증 → 3D·영상 시각화 → 배포 → 라이브 발표
```

---

## 7. 팀원별 Daily 작업 요약

| Day | A (친구) | B (Person 1) | C (너) | D (모두) |
|---|---|---|---|---|
| 1 | PRD + API 명세 | 봉+케이스 | PRD + GitHub Fork | standup |
| 2 | Backend 펌웨어 | 케이스 3D | UI + API 연동 | standup |
| 3 | Gateway 펌웨어 | Hanger 조립 | PWA | standup |
| 4 | 통합 테스트 | 봉 동박 | 발표 자료 | 리허설 |
| 5 | 배포 | 영상 촬영 | 슬라이드 | standup |
| 6 | 리허설 | 3D 시각화 | 영상 편집 | 리허설 |
| 7 | 발표 | 발표 자료 | 발표 | 발표 |

---

## 8. 위험 관리

| 위험 | 영향 | 대응 |
|---|---|---|
| 부품 배송 지연 | Day 1-2 펌웨어 불가 | **Day 1 즉시 주문** |
| RC522 짝퉁 | NFC 안 읽힘 | **PN532로 대체** (PRD V2) |
|통합 시점 차이 | Hanger/Gateway 안 맞음 | Day 3 오전 데모 |
| WiFi 끊김 | 시연 실패 | **백업 영상** (Day 5) |
| 시간 부족 | 발표 미완성 | **MVP 우선** (시연 통과) |

---

## 9. 변경 이력

| 버전 | 날짜 | 변경 |
|---|---|---|
| v1.0 | 2026-08-12 | 초안 작성 |
