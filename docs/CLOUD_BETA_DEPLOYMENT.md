# 무료 클라우드 친구 테스트 배포

목표는 **일주일 정도의 실제 친구 테스트**다. Render 무료 웹 서비스는 15분 동안 HTTP/WebSocket 요청이 없으면 잠들 수 있으므로, 언제나 즉시 반응해야 하는 정식 출시 용도가 아니다. 데이터는 Render 파일이 아닌 Supabase PostgreSQL에 저장해야 한다.

## 완료 조건

1. 다른 Wi-Fi/LTE에서도 HTTPS 주소로 웹 또는 앱 로그인 가능
2. 계정별 `wardrobe_id` 데이터가 PostgreSQL에 영구 보관
3. C3 옷봉이 공개 HTTPS API로 heartbeat와 태그 상태를 재전송
4. 전원 복구 후 첫 요청 실패 가능성을 허용하되, 다음 heartbeat에서 다시 ONLINE

## 준비할 계정

- Supabase 프로젝트 1개: 한국과 가까운 리전을 선택한다.
- Render 계정 1개와 GitHub 저장소 연결.

비밀값은 채팅·Git에 넣지 않는다. Supabase Dashboard와 Render 환경 변수 입력창에서만 사용한다.

## Supabase

1. Supabase Dashboard에서 프로젝트를 만든다.
2. SQL Editor에서 [`supabase/schema.sql`](../supabase/schema.sql)을 실행한다.
3. Settings > Database > Connect에서 **Transaction pooler** 연결 문자열을 복사해 Render 환경 변수 `DATABASE_URL`에만 넣는다. 비밀번호는 문자열 안에 포함되므로 채팅·Git에는 절대 붙여넣지 않는다.
4. 기존 `data/wardrobe.json`은 마이그레이션 성공을 확인할 때까지 절대 삭제하지 않는다.

### 기존 내 옷장 1회 이관

Render에 배포하기 **전에 내 PC에서** 다음을 한 번 실행한다. 이관기는 비어 있는 DB에서만 동작하며, 이미 친구 데이터가 있는 DB를 지우거나 덮어쓰지 않는다.

```powershell
$env:DATABASE_URL='<Supabase Transaction Pooler URL>'
$env:SEED_JSON_PATH='data/wardrobe.json'
npm run db:migrate
```

성공 메시지를 확인한 뒤 Supabase Table Editor에서 `app_users`, `garments`, `gateways`, `hangers`가 채워졌는지 확인한다. 그 뒤에만 Render의 `DATABASE_URL`에 같은 연결 문자열을 입력한다.

## Render

1. GitHub 저장소에서 새 Blueprint를 만들고 [`render.yaml`](../render.yaml)을 선택한다.
2. 생성된 `JWT_SECRET`, `DEVICE_TOKEN`은 기록해 둔다. C3 펌웨어의 장치 토큰은 Render의 `DEVICE_TOKEN`과 같아야 한다.
3. `PUBLIC_ORIGIN`에는 배포 완료 뒤의 Render HTTPS 주소를 넣는다.
4. `/api/health`가 HTTP 200인지 확인한다.

## C3 옷봉

배포 주소가 확정된 뒤 BLE 설정 화면에서 C3의 서버 주소를 `https://<render-domain>`으로 저장한다. 공개 서버는 HTTPS를 사용하므로, 그 전에 `firmware/gateway/include/config.h`에 해당 배포 도메인의 **공개 루트 CA PEM**을 `CLOUD_TLS_ROOT_CA`로 넣고 `ALLOW_INSECURE_HTTP`를 `0`으로 바꾼 HTTPS 펌웨어를 기록한다. 인증서는 비밀이 아니지만, `DEVICE_TOKEN`은 절대 노출하면 안 된다. 그 뒤 전원 복구·재시도 시험을 한다.

## 친구 테스트 시나리오

1. 친구 계정을 새로 만들고, 기존 계정의 옷이 보이지 않는지 확인한다.
2. 친구의 옷봉/옷걸이를 BLE로 등록하고 이름을 바꾼다.
3. 옷봉 전원을 20분 이상 끈 뒤 다시 켠다.
4. 첫 heartbeat 실패 가능성 뒤, 다음 heartbeat에서 서버가 ONLINE이 되는지 확인한다.
5. NTAG 부착·제거가 웹에 반영되는지 확인한다.

## 절대 하면 안 되는 것

- `SUPABASE_SERVICE_ROLE_KEY`, Wi-Fi 비밀번호, `DEVICE_TOKEN`을 Git에 커밋하지 않는다.
- Render 내부 파일에 JSON DB 또는 업로드 사진을 영구 저장하지 않는다.
- 무료 서버의 자동 기동 지연을 숨기기 위해 장비 재시도를 제거하지 않는다.
