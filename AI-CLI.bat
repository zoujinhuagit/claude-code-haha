@echo off
chcp 65001 >nul

:: 打开第一个窗口：运行代理
#start "代理程序" cmd /k ".\agentGateway.exe"

:: 等待1秒，保证代理先启动
timeout /t 1 /nobreak >nul

:: 打开第二个窗口：运行AI
#start "AI程序服务端" cmd /k "set SERVER_PORT=3456 && bun run .\src\server\index.ts"

#start "AI程序桌面端" cmd /k "set VITE_DESKTOP_SERVER_URL=http://127.0.0.1:3456 && cd desktop && bun run dev --host 127.0.0.1 --port 2026"

start "AI程序CLI" cmd /k "bun --env-file=.env .\src\entrypoints\cli.tsx %*"

echo 启动完成
#pause
