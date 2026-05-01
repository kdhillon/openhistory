"""
Test script: Create a Safavid Iran place=country node on OpenHistoricalMap.

Usage:
  1. Start the local server: source .env && uvicorn server.main:app --reload --port 8000
  2. Get an OHM OAuth token by visiting: http://localhost:8000/api/ohm/auth-url
     (copy the URL, visit it, authorize, grab the token from the redirect)
  3. Run: python3 scripts/test_ohm_create.py <OHM_ACCESS_TOKEN>
"""

import sys
import json
import urllib.request

API_BASE = "http://localhost:8000"

SAFAVID_IRAN = {
    "name": "Safavid Iran",
    "nameLocal": "دولت صفوی",
    "nameLocalLang": "fa",
    "lat": 32.6546,
    "lon": 51.6680,
    "startDate": "1501",
    "endDate": "1736",
    "wikidataQid": "Q170596",
    "wikipediaTitle": "Safavid Iran",
}


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/test_ohm_create.py <OHM_ACCESS_TOKEN>")
        print("\nTo get a token, visit the auth URL from: curl http://localhost:8000/api/ohm/auth-url")
        sys.exit(1)

    token = sys.argv[1]
    payload = {**SAFAVID_IRAN, "accessToken": token}

    print(f"Creating place=country node for '{SAFAVID_IRAN['name']}'...")
    print(f"  Coordinates: {SAFAVID_IRAN['lat']}, {SAFAVID_IRAN['lon']}")
    print(f"  Dates: {SAFAVID_IRAN['startDate']}–{SAFAVID_IRAN['endDate']}")
    print()

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{API_BASE}/api/ohm/create-label",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            print(f"Success!")
            print(f"  Node ID:      {result['nodeId']}")
            print(f"  Changeset ID: {result['changesetId']}")
            print(f"  View node:    https://www.openhistoricalmap.org/node/{result['nodeId']}")
            print(f"  View changeset: https://www.openhistoricalmap.org/changeset/{result['changesetId']}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        print(f"Error {e.code}: {detail}")
        sys.exit(1)


if __name__ == "__main__":
    main()
