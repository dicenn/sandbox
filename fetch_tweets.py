"""
Fetch Elon Musk's tweets using Twitter/X API v2.
Outputs: data/tweets.json
"""

import os
import json
import time
from datetime import datetime, timezone
import requests
from dotenv import load_dotenv

load_dotenv()

BEARER_TOKEN = os.environ["TWITTER_BEARER_TOKEN"]
ELON_USER_ID = "44196397"  # Elon Musk's Twitter user ID

HEADERS = {"Authorization": f"Bearer {BEARER_TOKEN}"}


def fetch_tweets(start_date: str, end_date: str) -> list[dict]:
    """Fetch all tweets by Elon within the date range using pagination."""
    url = f"https://api.twitter.com/2/users/{ELON_USER_ID}/tweets"
    params = {
        "start_time": f"{start_date}T00:00:00Z",
        "end_time": f"{end_date}T23:59:59Z",
        "max_results": 100,
        "tweet.fields": "created_at,text,public_metrics",
    }

    all_tweets = []
    next_token = None

    while True:
        if next_token:
            params["pagination_token"] = next_token

        resp = requests.get(url, headers=HEADERS, params=params)
        resp.raise_for_status()
        data = resp.json()

        tweets = data.get("data", [])
        all_tweets.extend(tweets)
        print(f"  Fetched {len(tweets)} tweets (total: {len(all_tweets)})")

        next_token = data.get("meta", {}).get("next_token")
        if not next_token:
            break

        # Respect rate limits: 1500 requests/15min on basic tier
        time.sleep(1)

    return all_tweets


def main():
    start_date = os.environ.get("START_DATE", "2024-01-01")
    end_date = os.environ.get("END_DATE", "2024-12-31")

    print(f"Fetching tweets from {start_date} to {end_date}...")
    tweets = fetch_tweets(start_date, end_date)

    os.makedirs("data", exist_ok=True)
    out_path = "data/tweets.json"
    with open(out_path, "w") as f:
        json.dump(tweets, f, indent=2)

    print(f"\nSaved {len(tweets)} tweets to {out_path}")


if __name__ == "__main__":
    main()
