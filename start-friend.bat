@echo off
cd /d "%~dp0"
title AI Dev MCP — Friend/Teammate Setup
color 0A

echo.
echo  =====================================================
echo   AI Dev MCP — Teammate Quick Start
echo  =====================================================
echo.
echo  This starts YOUR OWN MCP server on YOUR laptop.
echo  Your code never leaves your machine.
echo.

REM ── Check .env exists ────────────────────────────────────────────────────────
if not exist .env (
    echo  [SETUP] .env not found. Creating from .env.example...
    copy .env.example .env >nul
    echo.
    echo  !! ACTION REQUIRED before continuing:
    echo  !!
    echo  !! 1. Open .env in a text editor
    echo  !! 2. Set API_KEYS=yourname:YOUR_SECRET_KEY
    echo  !!    Generate a key with:
    echo  !!    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    echo  !! 3. Set ALLOWED_ROOTS=C:/Users/YourName
    echo  !! 4. Add your project to src/config/projects.json
    echo  !! 5. Re-run this script
    echo.
    notepad .env
    pause
    exit /b 1
)

REM ── Load .env ────────────────────────────────────────────────────────────────
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if not "%%a"=="" if not "%%~a:~0,1%%"=="#" set %%a=%%b
)

REM ── Check API key is configured ──────────────────────────────────────────────
if "%API_KEYS%"=="alice:REPLACE_WITH_RANDOM_KEY_1,bob:REPLACE_WITH_RANDOM_KEY_2" (
    echo  [ERROR] You haven't set your API_KEYS in .env yet!
    echo  Edit .env and replace the placeholder keys.
    notepad .env
    pause
    exit /b 1
)

REM ── Check npm dependencies ───────────────────────────────────────────────────
if not exist node_modules (
    echo  [SETUP] Installing npm dependencies...
    npm install
    echo.
)

REM ── Check cloudflared is installed ───────────────────────────────────────────
where cloudflared >nul 2>&1
if errorlevel 1 (
    echo  [SETUP] cloudflared not found. Installing...
    winget install Cloudflare.cloudflared
    echo.
)

REM ── Check Ollama model is pulled ─────────────────────────────────────────────
echo  [CHECK] Verifying Ollama model...
ollama list 2>nul | findstr /i "qwen2.5-coder" >nul
if errorlevel 1 (
    echo  [SETUP] Pulling qwen2.5-coder:7b model (one-time download ~4GB)...
    start "Ollama Pull" /wait cmd /c "ollama pull qwen2.5-coder:7b"
)

echo.
echo  Starting services in Windows Terminal...
echo.

REM ── Launch all services in Windows Terminal tabs ─────────────────────────────
REM Tab 1: ChromaDB
REM Tab 2: MCP Server
REM Tab 3: Cloudflare quick tunnel (no account needed — prints URL in console)
wt ^
new-tab -p "Command Prompt" -d "%cd%" --title "ChromaDB" ^
    cmd /k "echo [ChromaDB] Starting... && chroma run --path "%~dp0chroma" --host localhost --port 8000" ^
; new-tab -p "Command Prompt" -d "%cd%" --title "MCP Server" ^
    cmd /k "timeout /t 4 >nul && echo [MCP] Starting server on port %PORT%... && node src/index.js" ^
; new-tab -p "Command Prompt" -d "%cd%" --title "Cloudflare Tunnel" ^
    cmd /k "timeout /t 6 >nul && echo [TUNNEL] Starting free Cloudflare tunnel... && echo. && echo Copy the https://...trycloudflare.com URL below into: && echo   1. BASE_URL in your .env && echo   2. VS Code/IntelliJ extension Base URL setting && echo. && cloudflared tunnel --url http://localhost:%PORT%"

echo.
echo  =====================================================
echo   All services starting in Windows Terminal tabs.
echo.
echo   NEXT STEPS:
echo   1. Copy your tunnel URL from the 'Cloudflare Tunnel' tab
echo      (looks like https://random-words.trycloudflare.com)
echo   2. Paste it into .env as BASE_URL
echo   3. Paste it into VS Code/IntelliJ as the server URL
echo   4. Use your API key from .env in the extension settings
echo  =====================================================
echo.
pause
