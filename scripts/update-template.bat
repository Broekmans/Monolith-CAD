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
taskkill /im MonoLith.exe /f /t >nul 2>&1 && (echo   MonoLith closed, waiting 3 s...) || (echo   MonoLith was not running)
timeout /t 3 /nobreak >nul
echo Installing patch (PowerShell shows every step below)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $sw=[Diagnostics.Stopwatch]::StartNew(); function L($m){ Write-Host ('  [{0,5:N1} s] {1}' -f $sw.Elapsed.TotalSeconds, $m) }; try { $z=Get-Item 'MonoLith-patch.zip'; L ('Patch file: ' + [math]::Round($z.Length/1MB,1) + ' MB, ' + $z.LastWriteTime); $t=Join-Path $env:TEMP 'monolith-patch'; if (Test-Path $t) { L 'Removing old temp folder...'; Remove-Item $t -Recurse -Force }; L ('Unzipping to ' + $t + ' ...'); Expand-Archive -Force -LiteralPath 'MonoLith-patch.zip' -DestinationPath $t; $f=@(Get-ChildItem $t -Recurse -File); $tot=($f | Measure-Object Length -Sum).Sum; L ('Unzipped ' + $f.Count + ' files, ' + [math]::Round($tot/1MB,1) + ' MB'); $i=0; foreach ($x in $f) { $i++; $rel=$x.FullName.Substring($t.Length+1); $d=Join-Path 'MonoLith' $rel; New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null; Copy-Item -LiteralPath $x.FullName -Destination $d -Force; if ($x.Length -gt 1MB -or $i -eq $f.Count -or ($i -band 31) -eq 0) { L ('Copied ' + $i + '/' + $f.Count + '  ' + $rel + '  (' + [math]::Round($x.Length/1KB) + ' KB)') } }; $a=Get-Item 'MonoLith\resources\app.asar'; L ('Installed app.asar: ' + $a.Length + ' bytes'); L 'Removing temp folder...'; Remove-Item $t -Recurse -Force; L 'Done'; exit 0 } catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (echo. & echo UPDATE FAILED - see the message above. & goto end)
echo.
echo MonoLith updated to %V%. Starting MonoLith...
start "" "MonoLith\MonoLith.exe"
:end
echo.
pause
