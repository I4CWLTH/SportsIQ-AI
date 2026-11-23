"""Optional NBA pilot archive -> Neon sync. Never changes site predictions.

Usage (only after installing psycopg[binary] and setting SPORTSIQ_NEON_DATABASE_URL):
    python3 scripts/sync_nba_pilot_neon.py

The existing nba-pilot.json workflow remains authoritative until explicitly switched.
The sync is idempotent and uses one database transaction.
"""
import json
import os
from pathlib import Path


def sync():
    url = os.environ.get("SPORTSIQ_NEON_DATABASE_URL")
    if not url:
        raise SystemExit("SPORTSIQ_NEON_DATABASE_URL not set; no database changes made")
    import psycopg  # installed separately; not used by the production web server
    archive = Path("nba-pilot.json")
    data = json.loads(archive.read_text(encoding="utf-8"))
    for key in ("games", "completed", "evaluation"):
        if not isinstance(data.get(key), dict):
            raise ValueError(f"Archive missing valid {key} mapping")
    with psycopg.connect(url, connect_timeout=15) as conn:
        with conn.cursor() as cursor:
            for table, id_col, data_col, records in (
                ("nba_pilot_games", "game_id", "game_data", data["games"]),
                ("nba_pilot_completed", "game_id", "result_data", data["completed"]),
                ("nba_pilot_evaluations", "phase", "evaluation_data", data["evaluation"]),
            ):
                # Names here are hardcoded; source game IDs and payloads are parameterized.
                sql = (
                    f"INSERT INTO public.{table} ({id_col},{data_col}) "
                    f"VALUES (%s,%s::jsonb) ON CONFLICT ({id_col}) "
                    f"DO UPDATE SET {data_col}=excluded.{data_col},updated_at=now()"
                )
                cursor.executemany(sql, [
                    (str(identifier), json.dumps(payload, separators=(",", ":")))
                    for identifier, payload in records.items()
                ])
    print(f"Neon sync complete: {len(data['games'])} captured, "
          f"{len(data['completed'])} completed, "
          f"{len(data['evaluation'])} evaluation phases")


if __name__ == "__main__":
    sync()
