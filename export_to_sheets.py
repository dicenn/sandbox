"""
Export analysis results to Google Sheets.

Reads:
  - data/analysis.json          (summary statistics)
  - data/tweets_with_flight_context.csv  (per-tweet data)
  - data/flights_clean.json     (per-flight data)

Requires: credentials.json (Google service account)

Setup:
  1. Go to https://console.cloud.google.com
  2. Create a project, enable Google Sheets API + Google Drive API
  3. Create a Service Account, download credentials.json
  4. Share your target Google Sheet with the service account email as Editor
  5. Set GOOGLE_SHEET_ID env var (or in .env file)
     Optionally set GOOGLE_SHEETS_CREDENTIALS_FILE (default: data/credentials.json)
"""

import csv
import json
import os

import gspread
from dotenv import load_dotenv
from google.oauth2.service_account import Credentials

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

CREDENTIALS_FILE = os.environ.get(
    "GOOGLE_SHEETS_CREDENTIALS_FILE", "data/credentials.json"
)
SHEET_ID = os.environ["GOOGLE_SHEET_ID"]

DATA_DIR = "data"
ANALYSIS_FILE = os.path.join(DATA_DIR, "analysis.json")
TWEETS_CSV = os.path.join(DATA_DIR, "tweets_with_flight_context.csv")
FLIGHTS_FILE = os.path.join(DATA_DIR, "flights_clean.json")


def get_client() -> gspread.Client:
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


def get_or_create_worksheet(
    sheet: gspread.Spreadsheet, title: str, rows: int = 1000, cols: int = 26
) -> gspread.Worksheet:
    try:
        return sheet.worksheet(title)
    except gspread.WorksheetNotFound:
        return sheet.add_worksheet(title=title, rows=rows, cols=cols)


def write_summary(sheet: gspread.Spreadsheet, stats: dict):
    ws = get_or_create_worksheet(sheet, "Summary", rows=30, cols=3)
    ws.clear()
    ws.update("A1", [["Metric", "Value"]])
    rows = [
        [k.replace("_", " ").title(), v]
        for k, v in stats.items()
    ]
    ws.update("A2", rows)
    ws.format("A1:B1", {"textFormat": {"bold": True}})
    print(f"  Written: Summary ({len(rows)} metrics)")


def write_tweets(sheet: gspread.Spreadsheet, csv_path: str):
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        rows = list(reader)

    if not rows:
        return

    ws = get_or_create_worksheet(sheet, "Tweets", rows=len(rows) + 2, cols=len(rows[0]))
    ws.clear()
    ws.update("A1", rows, value_input_option="RAW")
    ws.format("A1:Z1", {"textFormat": {"bold": True}})
    ws.freeze(rows=1)
    print(f"  Written: Tweets ({len(rows) - 1} data rows, {len(rows[0])} columns)")


def write_flights(sheet: gspread.Spreadsheet, flights: list):
    if not flights:
        return

    headers = list(flights[0].keys())
    rows = [[str(f.get(h, "")) for h in headers] for f in flights]

    ws = get_or_create_worksheet(sheet, "Flights", rows=len(rows) + 2, cols=len(headers))
    ws.clear()
    ws.update("A1", [headers] + rows, value_input_option="RAW")
    ws.format("A1:Z1", {"textFormat": {"bold": True}})
    ws.freeze(rows=1)
    print(f"  Written: Flights ({len(rows)} rows, {len(headers)} columns)")


def main():
    print("Loading data...")
    with open(ANALYSIS_FILE) as f:
        analysis = json.load(f)
    with open(FLIGHTS_FILE) as f:
        flights = json.load(f)

    print("Connecting to Google Sheets...")
    client = get_client()
    sheet = client.open_by_key(SHEET_ID)

    print("Writing sheets...")
    write_summary(sheet, analysis)
    write_tweets(sheet, TWEETS_CSV)
    write_flights(sheet, flights)

    print(f"\nDone! View at: https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit")


if __name__ == "__main__":
    main()
