# 장애 해결

- 웹 접속 안 됨: `npm start`, 포트 8787, 방화벽, 주소를 확인합니다.
- S3 CLOUD FAIL: PC의 LAN IP, 서버 실행, DEVICE_TOKEN, 같은 LAN 여부를 확인합니다. `localhost` 금지.
- C6 NFC FAILED: PN532 I2C switch, VCC, GND, SDA/SCL, IRQ/RST를 확인합니다.
- ESP-NOW 미수신: S3 Wi-Fi 채널과 C6 sweep 로그를 확인하고 2.4 GHz AP를 사용합니다.
- UNKNOWN_TAG: 웹에 동일 UID를 등록합니다. UID 공백/콜론은 서버가 정규화합니다.
- CONFLICT: 같은 UID가 두 옷걸이에서 PRESENT인지 확인합니다. 자동 승자를 선택하지 않습니다.
- Find TIMEOUT: C6 전원/채널, 대상 ID, S3 COMMAND 로그, C6 ACK 로그를 차례로 봅니다.
- 이동 중 재부팅: Pogo 압축, 100 µF 극성/근접 배치, 동박 오염, 봉 끝 전압을 측정합니다.
