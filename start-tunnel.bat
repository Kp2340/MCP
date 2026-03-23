@echo off
title AI Dev MCP — Cloudflare Tunnel (ai.decorom.in)

echo.
echo  Cloudflare Tunnel: ai.decorom.in -^> localhost:3001
echo  Tunnel ID: 484eb8d5-49bb-4fb2-92d7-d9a28d5075f3
echo.

REM Use explicit config so cloudflared picks the MCP tunnel, not the zeveal one
cloudflared tunnel --config "%USERPROFILE%\.cloudflared\mcp-config.yml" run mcp

pause
