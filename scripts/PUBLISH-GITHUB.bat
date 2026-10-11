@echo off
rem Publishes the current MonoLith version (top of MonoLith-changelog.txt) to GitHub: source + release with download.
cd /d "%~dp0"
if not exist publish-github.ps1 (echo publish-github.ps1 not found next to this file & goto end)
powershell -NoProfile -ExecutionPolicy Bypass -File publish-github.ps1
:end
echo.
pause
