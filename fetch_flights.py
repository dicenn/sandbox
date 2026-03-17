"""
Fetch Elon's private jet flight history from ADS-B Exchange.
Outputs: data/flights.json

ADS-B Exchange historical API docs:
  https://www.adsbexchange.com/data/
  Endpoint: GET /api/aircraft/icao/{icao}/traces/{date}
  Or use the "history" endpoint for a date range.

The ICAO hex for N628TS is ~A835AF. We derive it, or you can hard-code it.
"""

import os
import json
import time
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv

load_dotenv()

ADSB_API_KEY = os.environ["ADSB_API_KEY"]
TAIL_NUMBER = os.environ.get("JET_TAIL_NUMBER", "N628TS")

# ADS-B Exchange v2 base URL
BASE_URL = "https://adsbexchange-com1.p.rapidapi.com/v2"
HEADERS = {
    "X-RapidAPI-Key": ADSB_API_KEY,
    "X-RapidAPI-Host": "adsbexchange-com1.p.rapidapi.com",
}


def registration_to_icao(tail: str) -> str:
    """
    Convert N-number to Mode S hex (ICAO 24-bit address).
    This is a known mapping; N628TS = A835AF.
    For other tail numbers, look up via the ADS-B Exchange reg endpoint.
    """
    resp = requests.get(
        f"{BASE_URL}/registration/{tail}/",
        headers=HEADERS,
    )
    resp.raise_for_status()
    data = resp.json()
    icao = data["ac"][0]["hex"] if data.get("ac") else None
    if not icao:
        raise ValueError(f"Could not resolve ICAO hex for {tail}")
    return icao.upper()


def fetch_flight_history(icao: str, start_date: str, end_date: str) -> list[dict]:
    """
    Fetch historical traces for an aircraft over a date range.
    Returns list of flight segments with takeoff/landing times.
    """
    flights = []
    current = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")

    while current <= end:
        date_str = current.strftime("%Y-%m-%d")
        url = f"{BASE_URL}/icao/{icao}/traces/{date_str}/"

        resp = requests.get(url, headers=HEADERS)
        if resp.status_code == 404:
            current += timedelta(days=1)
            time.sleep(0.5)
            continue
        resp.raise_for_status()

        data = resp.json()
        traces = data.get("traces", [])
        if traces:
            # Each trace is a position record; extract flight segments
            segments = extract_flight_segments(traces, date_str, icao)
            flights.extend(segments)
            print(f"  {date_str}: {len(segments)} flight segment(s)")
        else:
            print(f"  {date_str}: no data")

        current += timedelta(days=1)
        time.sleep(0.5)  # Be polite to the API

    return flights


def extract_flight_segments(traces: list, date: str, icao: str) -> list[dict]:
    """
    Parse raw trace data into discrete flight segments (takeoff -> landing).
    ADS-B trace format: [timestamp, lat, lon, alt_baro, groundspeed, ...]
    """
    if not traces:
        return []

    segments = []
    in_flight = False
    segment_start = None
    prev_point = None

    # Airborne threshold: altitude > 500ft and groundspeed > 50kts
    ALTITUDE_THRESHOLD = 500
    SPEED_THRESHOLD = 50

    for point in traces:
        if len(point) < 5:
            continue
        ts, lat, lon, alt, spd = point[0], point[1], point[2], point[3], point[4]
        alt = alt if isinstance(alt, (int, float)) else 0
        spd = spd if isinstance(spd, (int, float)) else 0

        airborne = alt > ALTITUDE_THRESHOLD and spd > SPEED_THRESHOLD

        if airborne and not in_flight:
            in_flight = True
            segment_start = ts
        elif not airborne and in_flight:
            in_flight = False
            if segment_start is not None:
                segments.append({
                    "icao": icao,
                    "date": date,
                    "takeoff_unix": segment_start,
                    "landing_unix": ts,
                    "takeoff_utc": datetime.utcfromtimestamp(segment_start).isoformat(),
                    "landing_utc": datetime.utcfromtimestamp(ts).isoformat(),
                    "duration_minutes": round((ts - segment_start) / 60, 1),
                })
                segment_start = None

        prev_point = point

    # Handle still-airborne at end of trace window
    if in_flight and segment_start is not None:
        segments.append({
            "icao": icao,
            "date": date,
            "takeoff_unix": segment_start,
            "landing_unix": None,
            "takeoff_utc": datetime.utcfromtimestamp(segment_start).isoformat(),
            "landing_utc": None,
            "duration_minutes": None,
        })

    return segments


def main():
    start_date = os.environ.get("START_DATE", "2024-01-01")
    end_date = os.environ.get("END_DATE", "2024-12-31")

    print(f"Resolving ICAO hex for {TAIL_NUMBER}...")
    icao = registration_to_icao(TAIL_NUMBER)
    print(f"  ICAO hex: {icao}")

    print(f"\nFetching flight history from {start_date} to {end_date}...")
    flights = fetch_flight_history(icao, start_date, end_date)

    os.makedirs("data", exist_ok=True)
    out_path = "data/flights.json"
    with open(out_path, "w") as f:
        json.dump(flights, f, indent=2)

    print(f"\nSaved {len(flights)} flight segments to {out_path}")


if __name__ == "__main__":
    main()
