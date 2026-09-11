@echo off
rem 本文件按 UTF-8(无 BOM)保存且含中文提示,先切到 UTF-8 代码页避免控制台乱码
chcp 65001 >nul
title ServerHub

rem 切到脚本所在目录:必须加引号(路径可能含 ^& 等 cmd 元字符),并检查是否真的切换成功,
rem 否则切换失败时脚本会在"错误的工作目录"里继续安装/构建,却照样打印成功信息
cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

echo ============================================
echo   ServerHub - Production Mode
echo   URL: http://localhost:3120
echo   (frontend built to dist, single port)
echo ============================================

rem 端口占用预检查(修复):旧版本不检查,3120 已被别人占用时照常 npm start ——
rem (a) 浏览器打开的是别人的服务;(b) server.listen 没有 error 监听,EADDRINUSE 只会被
rem 崩溃护栏记一条日志,留下既不监听也不退出的僵尸 node 进程;(c) 脚本死等端口可用。
rem 用系统自带的 netstat + findstr 判断(无需管理员权限),命中 LISTENING 即视为被占用。
netstat -ano | findstr /r /c:"[.:]3120 .*LISTENING" >nul 2>&1
if errorlevel 1 goto :port_free

echo [错误] 端口 3120 已被其他进程占用,ServerHub 无法启动。
echo        占用情况(最后一列是 PID):
netstat -ano | findstr /r /c:"[.:]3120 .*LISTENING"
echo        处理办法:结束该进程(任务管理器,或 taskkill /PID 进程号 /F)后重试。
echo        提示:此时强行启动没有意义,后端会因 EADDRINUSE 变成不监听的僵尸进程。
pause
exit /b 1

:port_free
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
rem 上面已确认 3120 空闲,所以这里的等待只针对"自己的后端还没起来"这一种情况。
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3120);break}catch{Start-Sleep -Milliseconds 500}};Start-Process 'http://localhost:3120'"
call npm start

echo.
echo Server stopped.
echo If the browser did not open automatically, visit http://localhost:3120
pause
exit /b 0

:cd_failed
echo [错误] 无法切换到脚本所在目录: "%~dp0"
echo        该路径不存在,或包含 cmd 特殊字符(如 ^&)。请在本地磁盘上重新运行本脚本。
pause
exit /b 1
