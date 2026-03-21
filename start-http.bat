@echo off
REM ─── AI Dev MCP Server — HTTP Mode Startup (Windows) ───────────────────────
REM Starts ChromaDB, then the HTTP+SSE MCP server.
REM Requires: Node.js 20+, Ollama running, ChromaDB CLI installed

title AI Dev MCP HTTP Server

echo.
echo ============================================================
echo  AI Dev MCP Server v5.0.0 - HTTP Mode
echo ============================================================
echo.

REM Load .env if it exists
if exist .env (
    echo Loading .env...
    for /f "tokens=1,* delims==" %%a in (.env) do (
        if not "%%a"=="" if not "%%a:~0,1%%"=="#" set %%a=%%b
    )
)

REM Start ChromaDB in background
echo Starting ChromaDB...
start "ChromaDB" /min cmd /c "chroma run --path ./chroma"
timeout /t 3 /nobreak >nul

REM Set transport to HTTP
set TRANSPORT=http
if "%PORT%"=="" set PORT=3001
if "%BASE_URL%"=="" set BASE_URL=http://localhost:3001

echo Starting MCP HTTP Server on port %PORT%...
echo.
node src/index.js
