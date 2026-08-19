# ESP-NOW 통신 명세

250바이트 이하 packed binary packet을 사용합니다. 필드는 magic, version, type, gateway/hanger ID, state, UID, sequence, boot ID, command ID, 16개 target code, error flags, firmware, checksum입니다. 상태 변경은 3회 randomized retry, 정상 heartbeat는 5~8초 jitter입니다. Gateway beacon은 2초마다, C6는 beacon 15초 미수신 시 채널 1~13 sweep을 수행합니다. 명령은 target application filtering 후 LED 실행과 ACK를 보냅니다. 현재 checksum은 손상 검출이지 암호 인증이 아니므로 양산 전 HMAC/PMK 보강이 필요합니다.
