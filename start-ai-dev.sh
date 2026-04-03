#!/bin/bash
cd "$(dirname "$0")"

echo "====================================="
echo "  Starting AI Dev MCP Environment"
echo "====================================="

# Function to handle cleanup on script exit
cleanup() {
    echo "Shutting down background services..."
    kill $CHROMA_PID $MCP_PID 2>/dev/null
    exit 0
}

# Trap SIGINT and SIGTERM
trap cleanup SIGINT SIGTERM EXIT

echo "Starting ChromaDB on port 8000..."
chroma run --host localhost --port 8000 > chroma.log 2>&1 &
CHROMA_PID=$!

echo "Starting MCP Server..."
sleep 3
node src/index.js > mcp.log 2>&1 &
MCP_PID=$!

echo "Starting AI Agent CLI..."
sleep 3
node src/agent/cli.js
