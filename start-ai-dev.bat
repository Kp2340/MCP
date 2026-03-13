@echo off
cd /d %~dp0

echo =====================================
echo   Starting AI Dev MCP Environment
echo =====================================

wt ^
new-tab -p "Command Prompt" -d "%cd%" cmd /k "echo Starting ChromaDB && chroma run --host localhost --port 8000" ^
; split-pane -H -d "%cd%" cmd /k "timeout /t 3 >nul && echo Starting MCP Server && node src/index.js" ^
; split-pane -V -d "%cd%" cmd /k "timeout /t 5 >nul && echo Starting AI Agent CLI && node src/agent/agent.js"