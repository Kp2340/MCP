#!/bin/bash

cd "$(dirname "$0")"

echo ""
echo "  AI Dev MCP Server"
echo ""

# Load .env file safely -- skip comments (#) and blank lines
if [ -f .env ]; then
    while IFS='=' read -r key value; do
        # Skip comments and empty lines
        if [[ -n "$key" && ! "$key" =~ ^# ]]; then
            export "$key=$value"
        fi
    done < .env
else
    echo "WARNING: .env file not found. Using defaults."
fi

# Function to handle cleanup on script exit
cleanup() {
    echo "Shutting down background services..."
    kill $CHROMA_PID 2>/dev/null
    exit 0
}

# Trap SIGINT and SIGTERM to kill ChromaDB when you stop the script
trap cleanup SIGINT SIGTERM EXIT

# Start ChromaDB in background
echo "Starting ChromaDB on port 8000..."
# Using silent output for chroma unless it throws an error
chroma run --path "$(pwd)/chroma" > chroma.log 2>&1 &
CHROMA_PID=$!

sleep 4

# Start MCP server
echo "Starting MCP server on port ${PORT}..."
echo "MCP SSE endpoint: ${BASE_URL}/sse"
echo ""
node src/index.js
