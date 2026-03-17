"""
Export analysis results to Google Sheets.
Reads: data/analysis.json
Requires: credentials.json (Google service account or OAuth2)

Setup:
  1. Go to https://console.cloud.google.com
  2. Create a project, enable Google Sheets API + Google Drive API
  3. Create a Service Account, download credentials.json
  4. Share your target Google Sheet with the service account email
  5. Set GOOGLE_SHEET_ID and GOOGLE_SHEETS_CREDENTIALS_FILE in .env
"""

import json
import os

import gspread
from google.oauth2.service_account import Credentials
from dotenv import load_dotenv

load_dotenv()

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

CREDENTIALS_FILE = os.environ.get("GOOGLE_SHEETS_CREDENTIALS_FILE", "credentials.json")
SHEET_ID = os.environ["GOOGLE_SHEET_ID"]
ANALYSIS_FILE = "data/analysis.json"


def get_client() -> gspread.Client:
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


def write_summary(sheet: gspread.Spreadsheet, summary: dict):
    ws = get_or_create_worksheet(sheet, "Summary", rows=20, cols=3)
    ws.clear()
    ws.update("A1", [["Metric", "Value"]])
    rows = [[k.replace("_", " ").title(), v] for k, v in summary.items()]
    ws.update("A2", rows)
    ws.format("A1:B1", {"textFormat": {"bold": True}})
    print("  Written: Summary")


def write_hourly(sheet: gspread.Spreadsheet, hourly: list[dict]):
    ws = get_or_create_worksheet(sheet, "Hourly Activity", rows=len(hourly) + 2, cols=6)
    ws.clear()
    if not hourly:
        return
    headers = list(hourly[0].keys())
    rows = [list(r.values()) for r in hourly]
    ws.update("A1", [headers] + rows)
    ws.format("A1:Z1", {"textFormat": {"bold": True}})
    print(f"  Written: Hourly Activity ({len(hourly)} rows)")


def write_tweets(sheet: gspread.Spreadsheet, tweets: list[dict]):
    ws = get_or_create_worksheet(sheet, "Tweets", rows=len(tweets) + 2, cols=6)
    ws.clear()
    if not tweets:
        return
    headers = ["id", "created_at", "text", "in_flight", "flight_id"]
    rows = [[str(t.get(h, "")) for h in headers] for t in tweets]
    ws.update("A1", [headers] + rows)
    ws.format("A1:E1", {"textFormat": {"bold": True}})
    print(f"  Written: Tweets ({len(tweets)} rows)")


def write_flights(sheet: gspread.Spreadsheet, flights: list[dict]):
    ws = get_or_create_worksheet(sheet, "Flights", rows=len(flights) + 2, cols=8)
    ws.clear()
    if not flights:
        return
    headers = list(flights[0].keys())
    rows = [[str(f.get(h, "")) for h in headers] for f in flights]
    ws.update("A1", [headers] + rows)
    ws.format("A1:Z1", {"textFormat": {"bold": True}})
    print(f"  Written: Flights ({len(flights)} rows)")


def get_or_create_worksheet(
    sheet: gspread.Spreadsheet, title: str, rows: int = 1000, cols: int = 26
) -> gspread.Worksheet:
    try:
        return sheet.worksheet(title)
    except gspread.WorksheetNotFound:
        return sheet.add_worksheet(title=title, rows=rows, cols=cols)


def main():
    print("Loading analysis data...")
    with open(ANALYSIS_FILE) as f:
        data = json.load(f)

    print("Connecting to Google Sheets...")
    client = get_client()
    sheet = client.open_by_key(SHEET_ID)

    print("Writing data...")
    write_summary(sheet, data["summary"])
    write_hourly(sheet, data["hourly"])
    write_tweets(sheet, data["tweets"])
    write_flights(sheet, data["flights"])

    print(f"\nDone! View your sheet at: https://docs.google.com/spreadsheets/d/{SHEET_ID}")


if __name__ == "__main__":
    main()
