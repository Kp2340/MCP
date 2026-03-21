@echo off
REM ─── AI Dev MCP Server — Stdio Mode (Claude Desktop) ───────────────────────
title AI Dev MCP Stdio Server

if exist .env (
    for /f "tokens=1,* delims==" %%a in (.env) do (
        if not "%%a"=="" if not "%%a:~0,1%%"=="#" set %%a=%%b
    )
)

set TRANSPORT=stdio
node src/index.js
