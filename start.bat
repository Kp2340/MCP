@echo off
cd /d "%~dp0"
title AI Dev MCP Server

echo.
echo  AI Dev MCP Server v5.1.0
echo.

REM Load .env file
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%~a:~0,1%%"=="#" set %%a=%%b
    )
) else (
    echo WARNING: .env file not found. Using defaults.
)

REM Start ChromaDB in background
echo Starting ChromaDB on port 8000...
start "ChromaDB" /min cmd /c "chroma run --path "%~dp0chroma""
timeout /t 4 /nobreak >nul

REM Start MCP server
echo Starting MCP server on port %PORT%...
echo Connect claude.ai to: %BASE_URL%/sse
echo.
node src/index.js
