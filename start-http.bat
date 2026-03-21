@echo off
title AI Dev MCP HTTP Server

echo.
echo  AI Dev MCP Server v5.0.0 - HTTP Mode
echo.

REM ── Environment ──────────────────────────────────────────────────────────────
set TRANSPORT=http
set PORT=3001
set BASE_URL=http://localhost:3001
set API_KEY=kush-full-stack-developer-java-with-react
set OLLAMA_HOST=http://localhost:11434
set LLM_MODEL=qwen2.5-coder:7b
set CHROMA_HOST=localhost
set CHROMA_PORT=8000
set JOB_TIMEOUT_MS=300000
set CORS_ORIGIN=*
set LOG_LEVEL=INFO

REM ── Services ──────────────────────────────────────────────────────────────────
echo Starting ChromaDB...
start "ChromaDB" /min cmd /c "chroma run --path ./chroma"
timeout /t 3 /nobreak >nul

REM Old — cloudflared (broken on your machine)
REM start "CF Tunnel" /min cmd /c "cloudflared tunnel --url http://127.0.0.1:3001 --protocol http2 > %TEMP%\cf-tunnel.log 2>&1"

REM New — ngrok
start "ngrok" /min cmd /c "ngrok http 3001 --log=stdout > %TEMP%\ngrok.log 2>&1"
timeout /t 5 /nobreak >nul

echo Starting MCP HTTP Server on port %PORT%...
echo.
node src/index.js