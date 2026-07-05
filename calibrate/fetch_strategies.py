"""
Fetch the ACTUAL race strategy every driver ran, per 2026 round - grid slot, finishing
position, tyre stints (compound + laps) and pit laps. This is the ground truth the backtest
compares our recommended strategy against, and what the app shows for past races.

Run:
    python calibrate/fetch_strategies.py --last 3      # or --rounds 1 2 3 / --all

Writes data/strategies/2026_R{rnd}.json (+ data/strategies/index.json).
Pure factual extraction - no modelling, no leakage concern (this is the real result).
"""
import os
import json
import argparse
import datetime as dt

import pandas as pd
import fastf1

YEAR = 2026
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "calibrate", "cache")
OUT_DIR = os.path.join(ROOT, "data", "strategies")


def driver_strategy(laps, drv):
    """Stints (compound + lap range) and pit laps for one driver."""
    dl = laps[laps["Driver"] == drv].sort_values("LapNumber")
    stints = []
    for stint_no, sl in dl.groupby("Stint"):
        comp = sl["Compound"].dropna()
        stints.append({
            "stint": int(stint_no),
            "compound": (str(comp.iloc[0]).lower() if len(comp) else None),
            "lap_start": int(sl["LapNumber"].min()),
            "lap_end": int(sl["LapNumber"].max()),
        })
    # pit laps = laps where the car came into the pits
    pit_laps = [int(x) for x in dl.loc[dl["PitInTime"].notna(), "LapNumber"].tolist()]
    return stints, pit_laps


def process_round(rnd):
    session = fastf1.get_session(YEAR, rnd, "R")
    session.load(laps=True, telemetry=False, weather=False, messages=False)
    laps = session.laps
    results = session.results  # DataFrame incl. Abbreviation, GridPosition, Position, TeamName
    ev = session.event

    drivers = []
    for _, r in results.iterrows():
        code = str(r["Abbreviation"])
        stints, pit_laps = driver_strategy(laps, code)
        drivers.append({
            "code": code,
            "driver": str(r.get("FullName", code)),
            "team": str(r.get("TeamName", "")),
            "grid": (int(r["GridPosition"]) if not pd.isna(r["GridPosition"]) else None),
            "finish": (int(r["Position"]) if not pd.isna(r["Position"]) else None),
            "status": str(r.get("Status", "")),
            "stops": len(pit_laps),
            "pit_laps": pit_laps,
            "stints": stints,
        })

    return {
        "year": YEAR,
        "round": rnd,
        "event": str(ev["EventName"]),
        "date": str(ev["EventDate"].date()),
        "total_laps": int(laps["LapNumber"].max()),
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "drivers": drivers,
    }


def resolve_rounds(args, schedule):
    done = []
    now = dt.datetime.now(dt.timezone.utc)
    for _, ev in schedule.iterrows():
        rnd = int(ev["RoundNumber"])
        if rnd == 0:
            continue
        d = ev["EventDate"]
        if d is not None and pd.Timestamp(d).tz_localize("UTC") < now:
            done.append(rnd)
    if args.rounds:
        return sorted(set(args.rounds))
    if args.all:
        return done
    return done[-args.last:] if done else []


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--last", type=int, default=3)
    g.add_argument("--rounds", type=int, nargs="+")
    g.add_argument("--all", action="store_true")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    fastf1.Cache.enable_cache(CACHE)

    schedule = fastf1.get_event_schedule(YEAR, include_testing=False)
    rounds = resolve_rounds(args, schedule)
    print(f"Fetching strategies for rounds: {rounds}")

    index = []
    for rnd in rounds:
        print(f"R{rnd} ...")
        try:
            data = process_round(rnd)
        except Exception as e:  # noqa: BLE001
            print(f"  R{rnd} FAILED: {type(e).__name__}: {e}")
            continue
        path = os.path.join(OUT_DIR, f"{YEAR}_R{rnd}.json")
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        print(f"  wrote {path}  ({len(data['drivers'])} drivers, {data['total_laps']} laps)")
        index.append({"round": rnd, "event": data["event"], "date": data["date"],
                      "total_laps": data["total_laps"], "file": f"{YEAR}_R{rnd}.json"})

    idx_path = os.path.join(OUT_DIR, "index.json")
    existing = {}
    if os.path.exists(idx_path):
        with open(idx_path) as f:
            for e in json.load(f).get("rounds", []):
                existing[e["round"]] = e
    for e in index:
        existing[e["round"]] = e
    with open(idx_path, "w") as f:
        json.dump({"year": YEAR, "rounds": [existing[k] for k in sorted(existing)]}, f, indent=2)
    print(f"Updated {idx_path}")


if __name__ == "__main__":
    main()
