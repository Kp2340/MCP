@echo off
cd /d "%~dp0"
title AI Dev MCP HTTP Server

echo.
echo  AI Dev MCP Server - HTTP Mode
echo.

REM Load .env — BASE_URL and PORT come from here, do NOT override them below
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%~a:~0,1%%"=="#" set %%a=%%b
    )
)

REM Start ChromaDB
echo Starting ChromaDB...
start "ChromaDB" /min cmd /c "chroma run --path "%~dp0chroma""
timeout /t 4 /nobreak >nul

REM Start MCP server
echo Starting MCP HTTP Server on port %PORT%...
echo MCP SSE endpoint: %BASE_URL%/sse
echo.
node src/index.js
