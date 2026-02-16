@echo off
title Start Server
cd /d "%~dp0"

echo Starting environment setup...

:: Check if package.json exists
if exist package.json (
    echo Installing npm dependencies...
    call npm install
) else (
    echo No package.json found — skipping npm install
)

:: Try to start with npm start if script exists
for /f "tokens=*" %%i in ('npm run ^| findstr /i "start"') do (
    echo Found npm start script.
    echo Starting server using "npm start"...
    call npm start
    goto :end
)

:: Fallback: use server.js if it exists
if exist server.js (
    echo Starting server using "node server.js"...
    call node server.js
    goto :end
)

echo ERROR: Could not find a start script or server.js
pause
exit /b 1

:end
echo Server stopped.
pause
