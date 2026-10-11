@echo off
rem Creates "MonoLith <version>.zip" with only the files needed to run the program.
rem Source: the installed MonoLith folder next to this file (so run UPDATE-MONOLITH.bat first).
cd /d "%~dp0"
echo === Make MonoLith zip ===
if not exist MonoLith\MonoLith.exe (echo MonoLith folder not found next to this file & goto end)
if not exist MonoLith\resources\app.asar (echo MonoLith\resources\app.asar missing - installation incomplete & goto end)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference='Stop'; try {" ^
 "  $ver='';" ^
 "  if (Test-Path 'MonoLith-changelog.txt') { $l = Get-Content 'MonoLith-changelog.txt' | Where-Object { $_ -match '^\d+\.\d+\.\d+' } | Select-Object -First 1; if ($l) { $ver = ($l -split ' ')[0] } };" ^
 "  if (-not $ver) { $ver = Get-Date -Format 'yyyy-MM-dd' };" ^
 "  $zip = Join-Path (Get-Location) ('MonoLith ' + $ver + '.zip');" ^
 "  $stage = Join-Path $env:TEMP 'monolith-zip'; $app = Join-Path $stage 'MonoLith';" ^
 "  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force };" ^
 "  New-Item -ItemType Directory -Path $app | Out-Null;" ^
 "  Write-Host 'Copying program files...';" ^
 "  Get-ChildItem 'MonoLith' -File | Where-Object { $_.Extension -notin '.log','.tmp','.bak' } | Copy-Item -Destination $app;" ^
 "  Copy-Item 'MonoLith\resources' -Destination $app -Recurse;" ^
 "  New-Item -ItemType Directory -Path (Join-Path $app 'locales') | Out-Null;" ^
 "  foreach ($loc in 'en-US.pak','nl.pak') { $p = Join-Path 'MonoLith\locales' $loc; if (Test-Path $p) { Copy-Item $p -Destination (Join-Path $app 'locales') } };" ^
 "  Write-Host ('Zipping to ' + $zip + ' ...');" ^
 "  if (Test-Path $zip) { Remove-Item $zip -Force };" ^
 "  Compress-Archive -Path $app -DestinationPath $zip -CompressionLevel Optimal;" ^
 "  Remove-Item $stage -Recurse -Force;" ^
 "  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1);" ^
 "  Write-Host ('Done: ' + (Split-Path $zip -Leaf) + ' (' + $mb + ' MB)') -ForegroundColor Green;" ^
 "  Write-Host 'To use: unzip anywhere and run MonoLith\MonoLith.exe';" ^
 "  exit 0 } catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (echo. & echo ZIP FAILED - see the message above.)
:end
echo.
pause
