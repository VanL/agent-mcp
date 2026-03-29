#!/bin/bash

# Script to check if version print is working correctly

LOG_FILE="$HOME/Library/Logs/Claude/mcp-server-agent-mcp.log"

echo "🔍 Checking agent-mcp logs for version print..."
echo "================================================"

# Look for version print in the last 100 lines
VERSION_LINES=$(tail -100 "$LOG_FILE" | grep "claude_code v")

if [ -n "$VERSION_LINES" ]; then
    echo "✅ Found version print:"
    echo "$VERSION_LINES"
    
    # Count occurrences
    COUNT=$(echo "$VERSION_LINES" | wc -l)
    echo ""
    echo "📊 Version was printed $COUNT time(s) in recent logs"
    
    # Check for errors
    ERROR_LINES=$(tail -100 "$LOG_FILE" | grep -i "error")
    if [ -n "$ERROR_LINES" ]; then
        echo ""
        echo "⚠️  Found errors in recent logs:"
        echo "$ERROR_LINES"
    fi
else
    echo "❌ No version print found in recent logs"
    echo ""
    echo "Recent log entries:"
    tail -20 "$LOG_FILE"
fi
