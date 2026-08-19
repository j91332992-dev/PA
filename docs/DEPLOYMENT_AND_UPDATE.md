# 배포·업데이트·복구

서버 업데이트 전 `data/wardrobe.json`과 `.bak`을 별도 위치에 백업합니다. `.env`는 백업하되 저장소에는 커밋하지 않습니다. 서버는 이전 릴리스를 보존해 롤백합니다. DB schemaVersion 변경 시 migration을 먼저 만듭니다. C6 V1은 USB, S3 V1은 USB 업데이트를 기본으로 하며 OTA는 서명/롤백 체계를 확정한 뒤 적용합니다. 업데이트 순서는 호환 서버 → gateway → hanger → web입니다. 장애 시 이전 서버 복원, DB 백업 복원, S3 USB 재플래시, C6 USB 재플래시 순으로 복구합니다.
