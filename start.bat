@echo off
title AI Dev MCP Server

echo.
echo  AI Dev MCP Server v5.0.0
echo  Both use cases active on port 3001
echo.

REM Load .env file if present
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%~a:~0,1%%"=="#" set %%a=%%b
    )
)

REM Start ChromaDB in background
echo Starting ChromaDB...
start "ChromaDB" /min cmd /c "chroma run --path ./chroma"

REM Wait for ChromaDB to be ready (poll instead of fixed timeout)
set CHROMA_READY=0
for /l %%i in (1,1,15) do (
    if !CHROMA_READY!==0 (
        timeout /t 2 /nobreak >nul
        curl -sf http://localhost:8000/api/v2/heartbeat >nul 2>&1 && set CHROMA_READY=1
    )
)
if !CHROMA_READY!==0 echo WARNING: ChromaDB may not be ready yet — semantic search may fail on first call

REM Start MCP server — single process, both use cases
echo Starting AI Dev MCP Server...
echo.
node src/index.js
