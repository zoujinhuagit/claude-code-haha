@echo off
chcp 936 >nul
title AI 服务管理器

set SERVER_PORT=3456
set VITE_DESKTOP_SERVER_URL=http://127.0.0.1:3456
:: 自启配置
set "REG_KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "REG_NAME=AiServiceManager"
set "SELF_PATH=%~f0"

:menu
cls
echo ==============================
echo     AI 服务管理脚本
echo ==============================
echo.
echo  1. 启动
echo  2. 停止
echo  3. 重新启动
echo  4. 卸载
echo  5. 开启开机自启
echo  6. 关闭开机自启
echo  7. 退出
echo.
echo ==============================
set /p choice=请选择操作 [1-7]:

if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto uninstall
if "%choice%"=="5" goto AutoStartOn
if "%choice%"=="6" goto AutoStartOff
if "%choice%"=="7" exit /b 0
goto menu

:start
cls
echo [信息] 正在启动 AI 服务...

:: 启动服务端（后台隐藏）
powershell -WindowStyle Hidden -Command "Start-Process cmd -WindowStyle Hidden -WorkingDirectory '%CD%' -ArgumentList '/c','set','SERVER_PORT=%SERVER_PORT%','&','bun','run','.\src\server\index.ts'"

timeout /t 3 /nobreak >nul

:: 启动桌面端（后台隐藏）
powershell -WindowStyle Hidden -Command "Start-Process cmd -WindowStyle Hidden -WorkingDirectory '%CD%\desktop' -ArgumentList '/c','set','VITE_DESKTOP_SERVER_URL=%VITE_DESKTOP_SERVER_URL%','&','bun','run','dev','--host','127.0.0.1','--port','2026'"

echo [完成] AI 服务已启动
echo.
echo  服务端端口 : %SERVER_PORT%
echo  桌面端地址 : http://127.0.0.1:2026
echo.
echo 按任意键返回主菜单...
pause >nul
goto menu

:stop
cls
echo [信息] 正在停止 AI 服务...

:: 按进程名关闭
taskkill /im bun.exe /f >nul 2>&1
taskkill /im node.exe /f >nul 2>&1

:: 按端口关闭（保险机制）
powershell "$p=Get-NetTCPConnection -LocalPort %SERVER_PORT% -ErrorAction SilentlyContinue; if($p){Stop-Process $p.OwningProcess -Force}" >nul 2>&1
powershell "$p=Get-NetTCPConnection -LocalPort 2026 -ErrorAction SilentlyContinue; if($p){Stop-Process $p.OwningProcess -Force}" >nul 2>&1

echo [完成] AI 服务已停止
echo.
echo 按任意键返回主菜单...
pause >nul
goto menu

:restart
cls
echo [信息] 正在重新启动 AI 服务...
call :stop
timeout /t 2 /nobreak >nul
call :start
goto menu

:uninstall
cls
echo [信息] 正在卸载 AI 服务...

:: 按进程名关闭
taskkill /im bun.exe /f >nul 2>&1
taskkill /im node.exe /f >nul 2>&1

:: 按端口关闭（保险机制）
powershell "$p=Get-NetTCPConnection -LocalPort %SERVER_PORT% -ErrorAction SilentlyContinue; if($p){Stop-Process $p.OwningProcess -Force}" >nul 2>&1
powershell "$p=Get-NetTCPConnection -LocalPort 2026 -ErrorAction SilentlyContinue; if($p){Stop-Process $p.OwningProcess -Force}" >nul 2>&1

echo [完成] AI 服务已卸载
echo.
echo 按任意键返回主菜单...
pause >nul
goto menu

:: ============ 新增：开启开机自启 ============
:AutoStartOn
cls
echo 正在设置开机自启...
reg add "%REG_KEY%" /v "%REG_NAME%" /t REG_SZ /d "\"%SELF_PATH%\"" /f >nul
if %errorlevel% equ 0 (
    echo ? 开机自启开启成功
) else (
    echo ? 设置失败
)
echo.
echo 按任意键返回菜单
pause >nul
goto menu

:: ============ 新增：关闭开机自启 ============
:AutoStartOff
cls
echo 正在取消开机自启...
reg delete "%REG_KEY%" /v "%REG_NAME%" /f >nul
if %errorlevel% equ 0 (
    echo ? 开机自启已关闭
) else (
    echo ?? 未找到自启项
)
echo.
echo 按任意键返回菜单
pause >nul
goto menu