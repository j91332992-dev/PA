param([switch]$InstallPlatformIO)
$ErrorActionPreference='Stop';$Root=Split-Path -Parent $PSScriptRoot;Set-Location $Root
if(-not(Get-Command node -ErrorAction SilentlyContinue)){throw 'Node.js 20 이상을 먼저 설치하세요: https://nodejs.org'}
npm install
if(-not(Test-Path '.env')){Copy-Item '.env.example' '.env';Write-Host '[필수] .env의 JWT_SECRET과 DEVICE_TOKEN을 긴 랜덤 값으로 변경하세요.' -ForegroundColor Yellow}
if($InstallPlatformIO){python -m pip install --user platformio}
Write-Host '설정 완료. npm start 후 http://localhost:8787 을 여세요.' -ForegroundColor Green
