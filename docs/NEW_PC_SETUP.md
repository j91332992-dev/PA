# 다른 PC 설치 및 이전

## 앱만 사용

[Releases](https://github.com/j91332992-dev/PA/releases/tag/apk-archive-2026-09-03)의 OTKOK-v1.0.6.apk를 Android 휴대폰으로 다운로드해 설치하세요. 이전 버전과 app-debug.apk는 보관·진단용입니다. 필요한 경우 다운로드한 브라우저/파일 앱의 '알 수 없는 앱 설치'와 앱의 블루투스/근처 기기 권한을 허용합니다. APK는 iOS용이 아닙니다.

앱은 https://otkok-live.vercel.app/ 에 연결합니다. 기존 계정으로 로그인하면 기존 데이터를 사용하며 PC를 켤 필요는 없습니다. 옷봉에는 전원과 인터넷 연결이 가능한 2.4 GHz Wi-Fi가 필요합니다. 휴대폰은 모바일 데이터를 사용해도 되며 근처 연결에는 블루투스가 필요합니다. PC 이전 때문에 기존 하드웨어에 펌웨어를 다시 올릴 필요는 없습니다.

## 소스 설치

Git, Node.js 20 이상을 설치합니다. 한글/OneDrive 경로 문제를 피하려면 영문 경로를 권장합니다.

```powershell
New-Item -ItemType Directory -Force C:\dev
Set-Location C:\dev
git clone --branch codex/otkok-vercel-release https://github.com/j91332992-dev/PA.git PA
Set-Location PA
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

package-lock.json과 mobile/pubspec.lock은 Git에 포함됩니다. node_modules와 빌드 캐시는 새 PC에서 생성합니다.

## 서버 환경설정

새 로컬 환경은 아래 명령으로 무작위 값을 생성해 .env의 JWT_SECRET에 입력하고, 다시 생성한 별도 값을 DEVICE_TOKEN에 입력합니다.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- DATABASE_URL을 비우면 로컬 JSON 데이터 환경입니다. 기존 회원/옷 정보가 자동으로 복사되지 않습니다.
- 기존 클라우드 환경을 사용할 때는 권한이 있는 계정으로 Vercel 프로젝트 Settings → Environment Variables에서 필요한 값을 비공개로 이전합니다. 운영 DB에 연결한 로컬 서버도 실제 데이터를 변경할 수 있습니다.
- 기존 하드웨어와 연결할 때 DEVICE_TOKEN은 장치에 설정된 값과 같아야 합니다. 운영 토큰을 임의로 바꾸면 인증에 실패합니다. 기존 로그인 토큰을 유지하려면 운영 JWT_SECRET도 유지합니다.
- 관리자 및 사진 처리 기능을 사용하는 경우 해당 환경값도 이전합니다. 실제 비밀값은 GitHub에 올리지 않습니다.

```powershell
npm start
```

http://localhost:8787 을 엽니다. 검증 명령은 npm test입니다. 로컬 실행만으로 운영 배포나 기존 APK의 접속 주소가 바뀌지 않습니다.

## APK 재빌드

Flutter SDK(Dart 3.13.1 이상 요구), Android Studio/SDK, Java 17 호환 환경을 준비하고 Flutter bin을 PATH에 추가합니다.

```powershell
flutter doctor -v
flutter doctor --android-licenses
Set-Location C:\dev\PA\mobile
flutter pub get
flutter build apk --release
```

출력은 mobile/build/app/outputs/flutter-apk/app-release.apk입니다. Flutter 빌드에서 Gradle 실행 파일 등 생성 파일을 준비합니다. Android local.properties는 새 PC의 SDK 경로로 생성합니다. 저장소의 mobile/third_party도 유지하세요. 앱 서버 주소는 mobile/lib/main.dart의 _webUrl이며 현재 기존 Vercel 서비스입니다.

현재 release 빌드는 debug signing 설정을 사용합니다. 새 PC의 키가 다르면 기존 APK 위에 업데이트 설치할 수 없습니다. 동일한 서명이 필요하면 기존 빌드의 Android 키(일반적으로 사용자 폴더의 .android/debug.keystore)를 암호화된 저장소 등 비공개 경로로 이전해야 합니다. 키를 GitHub에 올리지 마세요. 정식 출시용 서명 체계는 별도 준비가 필요합니다. 기존 키 없이 삭제 후 재설치하면 앱 내부 설정/권한을 다시 구성해야 할 수 있습니다. 원본 APK는 Releases에서 받을 수 있습니다.

## 펌웨어 개발이 필요한 경우에만

Python 설치 후 프로젝트 루트에서 실행합니다.

```powershell
Set-Location C:\dev\PA
python -m pip install --user platformio
if (!(Test-Path firmware/gateway/include/config.h)) {
  Copy-Item firmware/gateway/include/config.example.h firmware/gateway/include/config.h
}
if (!(Test-Path firmware/hanger/include/config.h)) {
  Copy-Item firmware/hanger/include/config.example.h firmware/hanger/include/config.h
}
```

옷봉 설정에 Wi-Fi, 서버 주소, 서버와 동일한 DEVICE_TOKEN 및 HTTPS 인증서 설정을 준비합니다. 실제 값은 비공개로 보관합니다.

```powershell
python -m platformio run -d firmware/gateway
python -m platformio run -d firmware/hanger
```

위 명령은 빌드만 하며 장치에 업로드하지 않습니다. 현재 build_dir는 C:/pio-build/gateway와 C:/pio-build/hanger입니다. 다른 운영체제에서는 쓰기 가능한 경로로 수정해야 합니다. 플랫폼 URL이 stable을 가리키므로 시간이 지나면 의존성 버전이 달라질 수 있으며 과거 바이너리와 완전히 같은 재빌드를 보장하지는 않습니다.

## 비공개 준비물과 이전 확인

- 운영 환경변수, 장치 인증 토큰, 필요한 Wi-Fi 설정, APK 서명 키는 별도로 안전하게 이전해야 합니다. 예제만으로 실제 비밀값을 복원할 수 없습니다.
- 기존 데이터는 Neon DB에 있으며 Git에는 포함되지 않습니다. 기존 서비스/DB에 접근할 권한이 필요합니다.
- 기존 GitHub/Vercel 프로젝트 접근 권한이 있으면 새 PC를 위해 새 유료 서비스나 DB를 만들 필요는 없습니다.
- 이전 후 앱 로그인·옷 목록·근처 연결, 개발 환경의 npm test·Flutter 빌드를 확인합니다.

이 안내는 현재 소스 설정을 기준으로 작성했습니다. 새 PC 클린 설치 및 실물 동작은 해당 환경에서 검증해야 합니다.
