param(
  [string]$Port='',
  [Parameter(Mandatory=$true)][string]$CloudBaseUrl
)

$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $PSScriptRoot
$envPath=Join-Path $Root '.env'
if(-not(Test-Path $envPath)){throw '.env 파일이 없어 Gateway 인증 토큰을 읽을 수 없습니다.'}
$tokenLine=Get-Content $envPath | Where-Object { $_ -match '^DEVICE_TOKEN=' } | Select-Object -First 1
$deviceToken=($tokenLine -split '=',2)[1].Trim()
if(-not $deviceToken){throw '.env의 DEVICE_TOKEN이 비어 있습니다.'}
if($CloudBaseUrl -notmatch '^https://'){throw '실서비스 Gateway는 https:// 공개 주소가 필요합니다.'}

$configPath=Join-Path $Root 'firmware\gateway\include\config.h'
@"
#pragma once
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define CLOUD_BASE_URL "$CloudBaseUrl"
#define DEVICE_TOKEN "$deviceToken"
#define CLOUD_TLS_ROOT_CA ""
#define ALLOW_INSECURE_HTTP 0
"@ | Set-Content -Encoding utf8 $configPath

$env:PLATFORMIO_CORE_DIR=Join-Path $Root '.pio-core'
$env:PLATFORMIO_DISABLE_TELEMETRY='1'
Set-Location "$Root\firmware\gateway"
$args=@('run','-t','upload')
if($Port){$args+=@('--upload-port',$Port)}
python -m platformio @args
