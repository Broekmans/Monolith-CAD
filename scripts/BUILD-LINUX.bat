@echo off
rem Starts (again) the Linux build on GitHub for the version at the top of MonoLith-changelog.txt and waits for it.
rem PUBLISH-GITHUB.bat does this by itself; use this file to retry or to build Linux for an already published version.
cd /d "%~dp0"
if not exist publish-github.ps1 (echo publish-github.ps1 not found next to this file & goto end)
powershell -NoProfile -ExecutionPolicy Bypass -File publish-github.ps1 -LinuxOnly
:end
echo.
pause
