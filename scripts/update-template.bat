@echo off
rem Applies MonoLith-patch.zip (version %V%) to the MonoLith folder next to this file.
cd /d "%~dp0"
echo === MonoLith update to %V% ===
rem One-time migration from the old install: copy EKCAD\ to MonoLith\ (copy, not rename, so a locked folder can't block it)
if exist EKCAD\EKCAD.exe if not exist MonoLith\MonoLith.exe (
  echo Creating MonoLith folder from the old install - this takes a minute...
  taskkill /im EKCAD.exe /f /t >nul 2>&1
  timeout /t 3 /nobreak >nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { Copy-Item -LiteralPath 'EKCAD' -Destination 'MonoLith' -Recurse -Force; Rename-Item -LiteralPath 'MonoLith\EKCAD.exe' -NewName 'MonoLith.exe'; exit 0 } catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
  if errorlevel 1 (echo. & echo Could not create the MonoLith folder - see the message above. & goto end)
  echo Done. The old EKCAD folder can be deleted later.
)
if not exist MonoLith\MonoLith.exe (
  echo Renaming old install to MonoLith...
  taskkill /im EKCAD.exe /f /t >nul 2>&1
  timeout /t 3 /nobreak >nul
  ren EKCAD MonoLith || (echo Could not rename the EKCAD folder - close the program and try again & goto end)
  ren MonoLith\EKCAD.exe MonoLith.exe
)
if not exist MonoLith\MonoLith.exe (echo MonoLith folder not found - run JOIN-AND-RUN-MONOLITH.bat first & goto end)
if not exist MonoLith-patch.zip (echo MonoLith-patch.zip not found next to this file & goto end)
echo Closing MonoLith...
taskkill /im MonoLith.exe /f /t >nul 2>&1
timeout /t 3 /nobreak >nul
echo Extracting patch...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $t=Join-Path $env:TEMP 'monolith-patch'; if (Test-Path $t) { Remove-Item $t -Recurse -Force }; Expand-Archive -Force -LiteralPath 'MonoLith-patch.zip' -DestinationPath $t; Copy-Item -Path (Join-Path $t '*') -Destination 'MonoLith' -Recurse -Force; Remove-Item $t -Recurse -Force; exit 0 } catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (echo. & echo UPDATE FAILED - see the message above. & goto end)
echo.
echo MonoLith updated to %V%. Starting MonoLith...
start "" "MonoLith\MonoLith.exe"
:end
echo.
pause
