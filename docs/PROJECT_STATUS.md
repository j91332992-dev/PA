# 구현 상태

완료(소프트웨어 검증 대상): 계정/로그인, 의류 UID 등록, 상태/충돌/오프라인 모델, WebSocket PWA, 단일/다중 Find, command ACK API, 50/100 가상노드 도구, PlatformIO C6/S3 소스, 설치/플래시 스크립트.

`REQUIRES_PHYSICAL_TEST`: PN532 실물 호환, NFC 거리/간섭, 실제 ESP-NOW 패킷/ACK/채널 회복, Pogo/자석/봉 전원, 전류/전압강하/퓨즈, 1/8/24시간, 50 physical nodes, HTTPS 공개 URL/LTE, local fallback embedded UI, OTA.

빌드 환경 메모: Node 단위/E2E 및 50노드 부하는 통과. C6 Arduino compile은 pioarduino까지 진입했으나 Windows 한글 사용자 경로의 toolchain path/CP949 오류로 이 PC에서 완료되지 못함: REQUIRES_ASCII_PATH_BUILD.
