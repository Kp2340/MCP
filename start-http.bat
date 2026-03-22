@echo off
cd /d "%~dp0"
title AI Dev MCP HTTP Server

echo.
echo  AI Dev MCP Server v5.1.0 - HTTP Mode
echo.

REM Load .env
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%~a:~0,1%%"=="#" set %%a=%%b
    )
)

set PORT=8080
set BASE_URL=http://localhost:8080

REM Start ChromaDB
echo Starting ChromaDB...
start "ChromaDB" /min cmd /c "chroma run --path "%~dp0chroma""
timeout /t 4 /nobreak >nul

REM Start Cloudflare Tunnel on port 8080
echo Starting Cloudflare Tunnel...
start "CF Tunnel" cmd /c "cloudflared tunnel --url http://localhost:8080 > "%TEMP%\cf-tunnel.log" 2>&1"
timeout /t 5 /nobreak >nul

REM Print the URL
echo.
for /f "tokens=*" %%a in ('type "%TEMP%\cf-tunnel.log" ^| findstr "trycloudflare.com"') do echo  URL: %%a
echo  Add above URL + /sse in claude.ai connector
echo.

REM Start MCP server on port 8080
echo Starting MCP HTTP Server on port 8080...
echo.
node src/index.js
