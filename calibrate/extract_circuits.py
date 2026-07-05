"""
Extract per-circuit assets from the FastF1 cache so the app can show ANY completed 2026 round:
  - track outline (normalised X/Y from a representative fast lap's position telemetry)
  - per-track constants: total_laps, base_lap_seconds (median clean lap), corner_time_share

Writes data/tracks/2026_R{n}.json and a combined data/races.json (the circuit picker's index).
Run:  python calibrate/extract_circuits.py [--rounds 1 2 ... | --all]
"""
import os
import json
import argparse

import numpy as np
import fastf1

YEAR = 2026
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "calibrate", "cache")
TRACK_DIR = os.path.join(ROOT, "data", "tracks")
N_POINTS = 90


def circuit_outline(session):
    """Normalised [0,1] closed outline from a fast lap's X/Y trace (Y flipped so north is up).
    Tries the session-fastest lap, then each driver's fastest, and uses merged telemetry which
    reliably carries X/Y (some laps' raw pos_data is missing)."""
    candidates = []
    try:
        candidates.append(session.laps.pick_fastest())
    except Exception:  # noqa: BLE001
        pass
    for drv in session.laps["Driver"].dropna().unique():
        try:
            candidates.append(session.laps.pick_drivers(drv).pick_fastest())
        except Exception:  # noqa: BLE001
            pass

    for lap in candidates:
        try:
            tel = lap.get_telemetry()  # merged pos+car data, has X/Y
            if "X" not in tel.columns:
                continue
            x = tel["X"].values.astype(float)
            y = tel["Y"].values.astype(float)
            if len(x) < 20 or (x.max() - x.min()) == 0:
                continue
            idx = np.linspace(0, len(x) - 1, N_POINTS).astype(int)
            x, y = x[idx], y[idx]
            sx = (x.max() - x.min()) or 1.0
            sy = (y.max() - y.min()) or 1.0
            return [[round(float((xi - x.min()) / sx), 4), round(float(1 - (yi - y.min()) / sy), 4)] for xi, yi in zip(x, y)]
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("no usable position telemetry")


def base_lap_seconds(laps):
    ql = laps.pick_quicklaps()
    secs = ql["LapTime"].dropna().apply(lambda t: t.total_seconds())
    return round(float(secs.median()), 3) if len(secs) else None


def process_round(rnd):
    session = fastf1.get_session(YEAR, rnd, "R")
    session.load(laps=True, telemetry=True, weather=False, messages=False)
    ev = session.event
    laps = session.laps

    outline = circuit_outline(session)
    track = {
        "name": str(ev["EventName"]),
        "round": rnd,
        "closed": True,
        "points": outline,
        "_source": "FastF1 position telemetry, fastest lap",
    }
    with open(os.path.join(TRACK_DIR, f"{YEAR}_R{rnd}.json"), "w") as f:
        json.dump(track, f)

    # per-track pace metadata (corner share) if the pace file exists
    corner_share = None
    pace_path = os.path.join(ROOT, "data", "pace", f"{YEAR}_R{rnd}.json")
    if os.path.exists(pace_path):
        corner_share = json.load(open(pace_path)).get("corner_time_share")

    return {
        "round": rnd,
        "event": str(ev["EventName"]),
        "date": str(ev["EventDate"].date()),
        "total_laps": int(laps["LapNumber"].max()),
        "base_lap_seconds": base_lap_seconds(laps),
        "corner_time_share": corner_share,
        "track_file": f"tracks/{YEAR}_R{rnd}.json",
        "pace_file": f"pace/{YEAR}_R{rnd}.json" if corner_share is not None else None,
        "strategy_file": f"strategies/{YEAR}_R{rnd}.json",
        "status": "completed",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, nargs="+")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    os.makedirs(TRACK_DIR, exist_ok=True)
    fastf1.Cache.enable_cache(CACHE)

    # default: every round that already has a strategy file (i.e. completed + fetched)
    strat_idx = json.load(open(os.path.join(ROOT, "data", "strategies", "index.json")))["rounds"]
    rounds = args.rounds or ([e["round"] for e in strat_idx] if not args.rounds else [])
    print(f"Extracting circuits for rounds: {rounds}")

    races = []
    for rnd in rounds:
        try:
            meta = process_round(rnd)
            races.append(meta)
            print(f"  R{rnd} {meta['event']}: {meta['total_laps']} laps, base {meta['base_lap_seconds']}s, "
                  f"cornerShare {meta['corner_time_share']}")
        except Exception as e:  # noqa: BLE001
            print(f"  R{rnd} FAILED: {type(e).__name__}: {e}")

    # append Silverstone (upcoming British GP, round 9), uses the hand-traced outline + quali grid,
    # predicted from all prior rounds. Kept separate so the app can flag it "upcoming".
    races.append({
        "round": 9,
        "event": "British Grand Prix",
        "date": "2026-07-05",
        "total_laps": 52,
        "base_lap_seconds": 91.0,
        "corner_time_share": 0.35,
        "track_file": "silverstone.json",
        "pace_file": None,
        "strategy_file": None,
        "status": "upcoming",
    })

    with open(os.path.join(ROOT, "data", "races.json"), "w") as f:
        json.dump({"year": YEAR, "races": races}, f, indent=2)
    print(f"Wrote data/races.json ({len(races)} rounds)")


if __name__ == "__main__":
    main()
