@echo off
title ServerHub
cd /d %~dp0

echo ============================================
echo   ServerHub - Production Mode
echo   URL: http://localhost:3120
echo   (frontend built to dist, single port)
echo ============================================

if not exist node_modules (
  echo [first run] installing dependencies, please wait...
  call npm install --cache .npm-cache --no-audit --no-fund
  if errorlevel 1 (
    echo ERROR: dependency install failed, check network.
    pause
    exit /b 1
  )
)

echo [1/2] building frontend...
call npm run build
if errorlevel 1 (
  echo ERROR: build failed, see error above.
  pause
  exit /b 1
)

echo [2/2] starting server (press Ctrl+C to stop)...
rem Poll until port 3120 is ready, then open the browser.
rem This avoids opening the browser before the server is up.
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3120);break}catch{Start-Sleep -Milliseconds 500}};Start-Process 'http://localhost:3120'"
call npm start

echo.
echo Server stopped.
echo If the browser did not open automatically, visit http://localhost:3120
pause
