@echo off
rem 本文件按 UTF-8(无 BOM)保存且含中文提示,先切到 UTF-8 代码页避免控制台乱码
chcp 65001 >nul
title ServerHub - Build Windows App

rem 切到脚本所在目录:必须加引号(路径可能含 ^& 等 cmd 元字符),并检查是否真的切换成功,
rem 否则切换失败时脚本会在"错误的工作目录"里继续打包,却照样打印成功信息
cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

echo ============================================
echo   ServerHub - 一键生成 Windows 应用
echo   产物: release\win-unpacked\ServerHub.exe
echo   (整个 win-unpacked 文件夹即为可运行的应用)
echo ============================================

rem 0) 首次运行安装依赖(electron / electron-builder 也在其中)
if not exist node_modules (
  echo [step 0/4] installing dependencies, please wait...
  call npm install --cache .npm-cache --no-audit --no-fund
  if errorlevel 1 (
    echo ERROR: dependency install failed, check network.
    pause
    exit /b 1
  )
)

rem 0.5) 确保 electron / electron-builder 已安装
call npm ls electron electron-builder --depth=0 >nul 2>&1
if errorlevel 1 (
  echo [step 0.5/4] installing electron + electron-builder...
  call npm install -D electron electron-builder --cache .npm-cache --no-audit --no-fund
  if errorlevel 1 (
    echo ERROR: electron install failed.
    pause
    exit /b 1
  )
)

rem 1) 生成应用图标
echo [step 1/4] generating app icon...
call npm run icon

rem 2) 构建前端 -> dist
echo [step 2/4] building frontend (vite)...
call npm run build
if errorlevel 1 (
  echo ERROR: frontend build failed, see error above.
  pause
  exit /b 1
)

rem 3) 用 electron-builder 生成应用(展开目录,非安装包)
echo [step 3/4] packaging Windows app (electron-builder --dir)...
call npx electron-builder --dir
if errorlevel 1 (
  echo ERROR: packaging failed, see error above.
  pause
  exit /b 1
)

rem 4) 汇总产物
echo.
echo ============================================
echo   Done! 应用目录: release\win-unpacked\
echo   运行方式: 双击 release\win-unpacked\ServerHub.exe
echo ============================================
echo.
echo   提示: 开发时用  npm run app:dev  -- 改代码应用即时刷新(HMR)。
echo   每次改了代码想更新这份应用,重跑本脚本即可。
echo.
pause
exit /b 0

:cd_failed
echo [错误] 无法切换到脚本所在目录: "%~dp0"
echo        该路径不存在,或包含 cmd 特殊字符(如 ^&)。请在本地磁盘上重新运行本脚本。
pause
exit /b 1
