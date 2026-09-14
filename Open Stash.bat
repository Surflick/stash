@echo off
setlocal
cd /d "%~dp0"
set "STASH_ROOT=%CD%"
set "VENDOR=%CD%\vendor\win-x64"
set "PATH=%VENDOR%;%PATH%"
set "YTDLP=%VENDOR%\yt-dlp.exe"

if not exist "%VENDOR%\node.exe" (
  echo Keep the whole Stash folder together. vendor\win-x64\node.exe is missing.
  pause
  exit /b 1
)
if not exist "%CD%\server\index.js" (
  echo Keep the whole Stash folder together. server\index.js is missing.
  pause
  exit /b 1
)

echo Starting Stash at http://127.0.0.1:47841
echo Leave this window open while you use it. Close it to quit.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:47841"
"%VENDOR%\node.exe" "%CD%\server\index.js"
if errorlevel 1 pause
