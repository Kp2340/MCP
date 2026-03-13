@echo off
cd /d %~dp0

echo =====================================
echo   AI Dev MCP  v9.0.0
echo =====================================

wt ^
new-tab -p "Command Prompt" -d "%cd%" cmd /k "echo [1/3] Starting ChromaDB... && chroma run --host localhost --port 8000" ^
; split-pane -H -d "%cd%" cmd /k "timeout /t 3 >nul && echo [2/3] Starting MCP Server... && node src/index.js" ^
; split-pane -V -d "%cd%" cmd /k "timeout /t 5 >nul && echo [3/3] Starting AI Agent CLI... && node src/agent/agent.js"
