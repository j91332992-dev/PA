# 시험 체크리스트

각 행에 날짜, 장치 ID, 버전, 측정값, 로그/사진 경로, PASS/FAIL을 기록하세요.

- H01 동박-봉 단락 없음; H02 무부하/부하 5 V; H03 hanger boot; H04 PN532 init; H05 UID 100회 인식률; H06 LED; H07 이동 중 최소전압/재부팅; H08 좌우 힘; H09 회전복원; H10 capacitor A/B; H11 fuse; H12 1/3/5/10 load.
- F01 boot; F02 PRESENT; F03 EMPTY; F04 UNKNOWN; F05 UNSTABLE; F06 ESP-NOW; F07 heartbeat; F08 command; F09 ACK; F10 AP 채널 변경 복구.
- S01 public URL; S02 LTE; S03 realtime; S04 find; S05 multi-find; S06 internet loss; S07 recovery; S08 backend restart; S09 gateway restart; S10 local fallback.
- 1 h, 8 h, 24 h 메모리/재부팅/손실/온도/전압 기록.

하드웨어 및 공개 서비스 항목은 실행 전 `REQUIRES_PHYSICAL_TEST`입니다.
