#!/usr/bin/env bash
# Run the full pipeline: fetch -> analyze -> export
set -euo pipefail

echo "=== Step 1: Fetch tweets ==="
python fetch_tweets.py

echo ""
echo "=== Step 2: Fetch flight data ==="
python fetch_flights.py

echo ""
echo "=== Step 3: Analyze correlation ==="
python analyze.py

echo ""
echo "=== Step 4: Export to Google Sheets ==="
python export_to_sheets.py

echo ""
echo "Pipeline complete!"
