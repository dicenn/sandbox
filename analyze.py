"""
Correlate Elon's tweet activity with his private jet flight periods.
Reads: data/tweets.json, data/flights.json
Outputs: data/analysis.json, data/analysis.csv
"""

import json
import os
from datetime import datetime, timedelta, timezone

import pandas as pd

TWEET_FILE = "data/tweets.json"
FLIGHT_FILE = "data/flights.json"
OUT_JSON = "data/analysis.json"
OUT_CSV = "data/analysis.csv"

# How many minutes before/after takeoff/landing to include in the "flight window"
BUFFER_MINUTES = 30


def load_tweets() -> pd.DataFrame:
    with open(TWEET_FILE) as f:
        tweets = json.load(f)
    df = pd.DataFrame(tweets)
    df["created_at"] = pd.to_datetime(df["created_at"], utc=True)
    df = df.sort_values("created_at").reset_index(drop=True)
    return df


def load_flights() -> pd.DataFrame:
    with open(FLIGHT_FILE) as f:
        flights = json.load(f)
    df = pd.DataFrame(flights)
    df["takeoff_utc"] = pd.to_datetime(df["takeoff_utc"], utc=True)
    df["landing_utc"] = pd.to_datetime(df["landing_utc"], utc=True, errors="coerce")
    df = df.dropna(subset=["landing_utc"])  # Drop open-ended segments
    return df


def tag_tweets_with_flight_status(tweets: pd.DataFrame, flights: pd.DataFrame) -> pd.DataFrame:
    """Add 'in_flight' and 'flight_id' columns to tweets."""
    buffer = timedelta(minutes=BUFFER_MINUTES)

    in_flight_flags = []
    flight_ids = []

    for _, tweet in tweets.iterrows():
        ts = tweet["created_at"]
        matched = False
        for i, flight in flights.iterrows():
            window_start = flight["takeoff_utc"] - buffer
            window_end = flight["landing_utc"] + buffer
            if window_start <= ts <= window_end:
                in_flight_flags.append(True)
                flight_ids.append(i)
                matched = True
                break
        if not matched:
            in_flight_flags.append(False)
            flight_ids.append(None)

    tweets = tweets.copy()
    tweets["in_flight"] = in_flight_flags
    tweets["flight_id"] = flight_ids
    return tweets


def build_hourly_timeseries(tweets: pd.DataFrame) -> pd.DataFrame:
    """Build an hourly bucket with tweet count and in-flight status."""
    tweets = tweets.copy()
    tweets["hour"] = tweets["created_at"].dt.floor("h")
    hourly = (
        tweets.groupby("hour")
        .agg(
            tweet_count=("id", "count"),
            in_flight_tweets=("in_flight", "sum"),
        )
        .reset_index()
    )
    hourly["pct_in_flight"] = (hourly["in_flight_tweets"] / hourly["tweet_count"] * 100).round(1)
    return hourly


def compute_correlation_stats(tweets: pd.DataFrame) -> dict:
    """Compute key statistics comparing in-flight vs grounded tweet rates."""
    in_flight = tweets[tweets["in_flight"]]
    grounded = tweets[~tweets["in_flight"]]

    # Tweets per hour (rate) during flight vs not
    def hourly_rate(df):
        if df.empty:
            return 0
        span_hours = (df["created_at"].max() - df["created_at"].min()).total_seconds() / 3600
        return round(len(df) / max(span_hours, 1), 2)

    return {
        "total_tweets": len(tweets),
        "tweets_during_flight": len(in_flight),
        "tweets_grounded": len(grounded),
        "pct_tweets_during_flight": round(len(in_flight) / max(len(tweets), 1) * 100, 1),
        "hourly_rate_in_flight": hourly_rate(in_flight),
        "hourly_rate_grounded": hourly_rate(grounded),
        "ratio_flight_vs_ground": round(
            hourly_rate(in_flight) / max(hourly_rate(grounded), 0.01), 2
        ),
    }


def main():
    print("Loading tweets...")
    tweets = load_tweets()
    print(f"  {len(tweets)} tweets loaded")

    print("Loading flights...")
    flights = load_flights()
    print(f"  {len(flights)} flight segments loaded")

    print(f"\nTagging tweets (±{BUFFER_MINUTES}min flight window)...")
    tweets = tag_tweets_with_flight_status(tweets, flights)

    print("Computing correlation stats...")
    stats = compute_correlation_stats(tweets)

    print("\n--- Results ---")
    for k, v in stats.items():
        print(f"  {k}: {v}")

    print("\nBuilding hourly time series...")
    hourly = build_hourly_timeseries(tweets)

    # Merge flight info into hourly series
    def is_flight_hour(row, flights):
        for _, f in flights.iterrows():
            if f["takeoff_utc"] <= row["hour"] <= f["landing_utc"]:
                return True
        return False

    hourly["jet_in_air"] = hourly["hour"].apply(
        lambda h: any(f["takeoff_utc"] <= h <= f["landing_utc"] for _, f in flights.iterrows())
    )

    os.makedirs("data", exist_ok=True)

    # Save analysis JSON
    result = {
        "summary": stats,
        "hourly": hourly.to_dict(orient="records"),
        "tweets": tweets[["id", "created_at", "text", "in_flight", "flight_id"]].assign(
            created_at=lambda df: df["created_at"].astype(str)
        ).to_dict(orient="records"),
        "flights": flights.assign(
            takeoff_utc=lambda df: df["takeoff_utc"].astype(str),
            landing_utc=lambda df: df["landing_utc"].astype(str),
        ).to_dict(orient="records"),
    }
    with open(OUT_JSON, "w") as f:
        json.dump(result, f, indent=2, default=str)

    # Save CSV for easy inspection
    export_df = tweets[["id", "created_at", "text", "in_flight"]].copy()
    export_df["created_at"] = export_df["created_at"].astype(str)
    export_df.to_csv(OUT_CSV, index=False)

    print(f"\nSaved analysis to {OUT_JSON} and {OUT_CSV}")


if __name__ == "__main__":
    main()
