@echo off
cd /d "%~dp0"
title AI Dev MCP Server

echo.
echo  AI Dev MCP Server
echo.

REM Load .env file safely -- skip comments (#) and blank lines
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (`findstr /v "^#" .env`) do (
        if not "%%A"=="" (
            set "%%A=%%B"
        )
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
echo MCP SSE endpoint: %BASE_URL%/sse
echo.
node src/index.js
