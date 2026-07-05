"""
Step 1 - check which 2026 F1 sessions have data available yet.

Run (after `conda activate f1-calibrate`, from the project root):
    python calibrate/check_data.py

It prints a table of every 2026 round and whether the Race (and Sprint, on sprint
weekends) timing data can be loaded via FastF1, and writes data/availability.json.
Nothing here needs the browser app; it only reads from the F1 API and caches locally.
"""
import os
import json
import datetime as dt

import fastf1

YEAR = 2026
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "calibrate", "cache")
OUT = os.path.join(ROOT, "data", "availability.json")


def main():
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fastf1.Cache.enable_cache(CACHE)

    schedule = fastf1.get_event_schedule(YEAR, include_testing=False)
    now = dt.datetime.now(dt.timezone.utc)

    rows = []
    print(f"{'Rnd':>3}  {'Event':<30} {'Format':<12} {'Race':<14} {'Sprint':<14}")
    print("-" * 78)

    for _, ev in schedule.iterrows():
        rnd = int(ev["RoundNumber"])
        if rnd == 0:
            continue
        name = str(ev["EventName"])
        fmt = str(ev.get("EventFormat", "conventional"))
        is_sprint = "sprint" in fmt.lower()

        status = {}
        for code, key in [("R", "race"), ("S", "sprint")]:
            if code == "S" and not is_sprint:
                status[key] = None
                continue
            try:
                s = fastf1.get_session(YEAR, rnd, code)
                s.load(laps=True, telemetry=False, weather=False, messages=False)
                nlaps = int(len(s.laps))
                status[key] = {"available": nlaps > 0, "laps": nlaps}
            except Exception as e:  # noqa: BLE001 - report, don't crash the sweep
                status[key] = {"available": False, "error": type(e).__name__}

        def cell(st):
            if st is None:
                return "-"
            if st.get("available"):
                return f"OK ({st['laps']})"
            return f"no ({st.get('error', 'n/a')})"

        print(f"{rnd:>3}  {name:<30} {fmt:<12} {cell(status['race']):<14} {cell(status['sprint']):<14}")
        rows.append({
            "round": rnd,
            "event": name,
            "format": fmt,
            "date": str(ev["EventDate"].date()) if ev["EventDate"] is not None else None,
            "race": status["race"],
            "sprint": status["sprint"],
        })

    with open(OUT, "w") as f:
        json.dump({"year": YEAR, "generated_utc": now.isoformat(), "rounds": rows}, f, indent=2)
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
