"""
Step 2 - fetch real per-car pace from recent 2026 races and write it as JSON the app can read.

Run (from the project root, env activated):
    python calibrate/fetch_pace.py --last 3          # the last 3 completed races
    python calibrate/fetch_pace.py --rounds 1 2 3    # specific rounds
    python calibrate/fetch_pace.py --all             # every available round

For each round it loads the Race session (laps + telemetry) and computes, per driver:
  - pace_delta_s:     clean-air, fuel-corrected race-pace deficit vs the fastest car (s/lap)
  - corner_delta_s:   extra time lost in the CORNER portions of a representative fast lap (s/lap)
  - straight_delta_s: extra time lost on the STRAIGHT portions (s/lap)
  - deg_per_lap_s:    per-compound tyre-degradation slope (s per lap of tyre age)
and writes data/pace/2026_R{rnd}.json  (+ maintains data/pace/index.json).

IMPORTANT - data-leakage design: each round is written to its OWN file. The app / backtest
must only ever aggregate rounds STRICTLY BEFORE the race being predicted. Never mix a race's
own data into its own prediction. (Round 1 therefore has no prior data -> the app should fall
back to flat/no-info pace for it; this is expected and is why Round 1 is the weakest.)

The pace numbers use standard but heuristic corrections (fuel model + quick-lap filtering +
green-flag only). They are a solid starting point, not a perfect clean-air/traffic-filtered
model; refine the CONSTANTS below or the filters as needed.
"""
import os
import json
import argparse
import datetime as dt

import numpy as np
import pandas as pd
import fastf1

YEAR = 2026
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "calibrate", "cache")
OUT_DIR = os.path.join(ROOT, "data", "pace")

# --- tuning constants (documented so they can be adjusted) ---
FUEL_S_PER_LAP = 0.055     # car gets ~this much faster per lap as fuel burns; used to fuel-correct
CORNER_SPEED_KMH = 200.0   # telemetry samples slower than this count as "corner", else "straight"
QUICKLAP_THRESH = 1.06     # keep laps within this fraction of the driver's own fastest (drop traffic/mistakes)


def _seconds(td):
    """timedelta / NaT -> float seconds or nan."""
    if td is None or pd.isna(td):
        return np.nan
    return td.total_seconds()


def clean_race_pace(laps):
    """Per-driver fuel-corrected median clean lap time (seconds). Returns {driver: secs}."""
    out = {}
    for drv in laps["Driver"].dropna().unique():
        dl = laps[laps["Driver"] == drv].copy()
        # green-flag laps only, exclude in/out laps and the first two (formation/settling)
        dl = dl[(dl["TrackStatus"].astype(str) == "1")]
        dl = dl[dl["PitInTime"].isna() & dl["PitOutTime"].isna()]
        dl = dl[dl["LapNumber"] > 2]
        secs = dl["LapTime"].apply(_seconds).dropna()
        if len(secs) < 5:
            continue
        # drop slow outliers (traffic, lifts): keep within QUICKLAP_THRESH of the driver's best
        secs = secs[secs <= secs.min() * QUICKLAP_THRESH]
        # fuel-correct to a common reference: remove the benefit of burned fuel
        laps_run = dl.loc[secs.index, "LapNumber"].astype(float)
        corrected = secs.values + FUEL_S_PER_LAP * laps_run.values
        out[drv] = float(np.median(corrected))
    return out


GRID_N = 500       # distance-grid resolution for telemetry resampling
NFAST_LAPS = 3     # average corner/straight over each driver's N fastest clean laps


def _resample_speed(lap, grid):
    """Interpolate a lap's Speed onto a common distance grid (km/h)."""
    tel = lap.get_car_data().add_distance()
    d = tel["Distance"].values
    v = tel["Speed"].values
    return np.interp(grid, d, v)


def track_zones(session, drivers):
    """Segment the lap into CORNER vs STRAIGHT distance-zones using the field-median speed
    profile (so the same stretches of track are 'corner' for everyone - removes the per-lap
    threshold noise). Returns (grid, corner_mask, cell_dist)."""
    lap_dist = None
    profiles = []
    for drv in drivers:
        try:
            lap = session.laps.pick_drivers(drv).pick_fastest()
            tel = lap.get_car_data().add_distance()
            if lap_dist is None:
                lap_dist = float(tel["Distance"].max())
            grid = np.linspace(0, lap_dist, GRID_N)
            profiles.append(np.interp(grid, tel["Distance"].values, tel["Speed"].values))
        except Exception:  # noqa: BLE001
            continue
    grid = np.linspace(0, lap_dist, GRID_N)
    median_speed = np.median(np.vstack(profiles), axis=0)
    corner_mask = median_speed < CORNER_SPEED_KMH
    cell_dist = grid[1] - grid[0]
    return grid, corner_mask, cell_dist


def corner_straight_split(session, drivers, grid, corner_mask, cell_dist):
    """Per-driver (corner_time, straight_time) in seconds, computed on FIXED track zones and
    averaged over the driver's fastest few clean laps. Time in a cell = cell_distance / speed,
    which is naturally bounded and far less noisy than a single raw lap."""
    out = {}
    for drv in drivers:
        try:
            laps = session.laps.pick_drivers(drv).pick_quicklaps()
            laps = laps.sort_values("LapTime").head(NFAST_LAPS)
            corner_ts, straight_ts = [], []
            for _, lp in laps.iterrows():
                v = np.clip(_resample_speed(lp, grid), 30, None)   # km/h, avoid div-by-zero
                cell_time = cell_dist / (v / 3.6)                  # seconds per cell
                corner_ts.append(float(cell_time[corner_mask].sum()))
                straight_ts.append(float(cell_time[~corner_mask].sum()))
            if corner_ts:
                out[drv] = (float(np.median(corner_ts)), float(np.median(straight_ts)))
        except Exception:  # noqa: BLE001
            continue
    return out


def deg_by_compound(laps):
    """Per-compound tyre-degradation slope (s per lap of tyre age). Fitted WITHIN each stint
    after fuel-correcting (so the fuel-burn gain isn't mistaken for negative deg), then the
    median slope per compound. Clamped at >= 0 (tyres don't get faster with age)."""
    from collections import defaultdict
    slopes = defaultdict(list)
    for (_, _), sl in laps.groupby(["Driver", "Stint"]):
        comps = sl["Compound"].dropna()
        if len(comps) == 0:
            continue
        comp = str(comps.iloc[0]).lower()
        sl = sl[(sl["TrackStatus"].astype(str) == "1") & sl["PitInTime"].isna() & sl["PitOutTime"].isna()]
        secs = sl["LapTime"].apply(_seconds)
        age = sl["TyreLife"].astype(float)
        lapno = sl["LapNumber"].astype(float)
        m = secs.notna() & age.notna() & lapno.notna()
        if m.sum() < 5:
            continue
        corrected = secs[m].values + FUEL_S_PER_LAP * lapno[m].values  # remove fuel-burn gain
        keep = np.abs(corrected - np.median(corrected)) < 2.0          # drop SC/traffic outliers
        if keep.sum() < 4:
            continue
        slope = float(np.polyfit(age[m].values[keep], corrected[keep], 1)[0])
        slopes[comp].append(slope)
    return {c: round(max(0.0, float(np.median(v))), 4) for c, v in slopes.items() if v}


def process_round(rnd, session_type="R"):
    session = fastf1.get_session(YEAR, rnd, session_type)
    session.load(laps=True, telemetry=True, weather=False, messages=False)
    laps = session.laps
    ev = session.event

    pace = clean_race_pace(laps)
    if not pace:
        print(f"  R{rnd}: no usable laps, skipping")
        return None
    best_pace = min(pace.values())

    drivers = list(pace.keys())
    grid, corner_mask, cell_dist = track_zones(session, drivers)
    cs = corner_straight_split(session, drivers, grid, corner_mask, cell_dist)
    best_corner = min((c for c, _ in cs.values()), default=None)
    best_straight = min((s for _, s in cs.values()), default=None)
    # fraction of a clean lap spent cornering vs on straights (track characteristic)
    corner_share = round(float(corner_mask.mean()), 3)

    deg = deg_by_compound(laps)

    out_drivers = {}
    for drv in drivers:
        entry = {"pace_delta_s": round(pace[drv] - best_pace, 3)}
        if drv in cs and best_corner is not None:
            c, s = cs[drv]
            entry["corner_delta_s"] = round(c - best_corner, 3)
            entry["straight_delta_s"] = round(s - best_straight, 3)
        out_drivers[drv] = entry

    return {
        "year": YEAR,
        "round": rnd,
        "event": str(ev["EventName"]),
        "date": str(ev["EventDate"].date()),
        "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "notes": "pace_delta/corner_delta/straight_delta are seconds slower than the best car; corner/straight on fixed track zones, median of fastest clean laps; deg is within-stint fuel-corrected.",
        "deg_per_lap_s": deg,
        "corner_speed_kmh": CORNER_SPEED_KMH,
        "corner_time_share": corner_share,
        "drivers": out_drivers,
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
    g.add_argument("--last", type=int, default=3, help="fetch the last N completed rounds")
    g.add_argument("--rounds", type=int, nargs="+", help="specific round numbers")
    g.add_argument("--all", action="store_true", help="all completed rounds")
    ap.add_argument("--sprint", action="store_true",
                     help="fetch the SPRINT session instead of the race (same-weekend bonus pace "
                          "signal for a round whose race hasn't run yet; NOT a leakage violation, "
                          "since it's data from earlier the same weekend, not a future round). "
                          "Writes data/pace/{year}_R{n}_sprint.json instead of the race file.")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    fastf1.Cache.enable_cache(CACHE)

    schedule = fastf1.get_event_schedule(YEAR, include_testing=False)
    rounds = args.rounds if (args.sprint and args.rounds) else resolve_rounds(args, schedule)
    print(f"Fetching {'SPRINT' if args.sprint else 'race'} pace for rounds: {rounds}")

    index = []
    for rnd in rounds:
        print(f"R{rnd} ...")
        try:
            data = process_round(rnd, session_type="S" if args.sprint else "R")
        except Exception as e:  # noqa: BLE001
            print(f"  R{rnd} FAILED: {type(e).__name__}: {e}")
            continue
        if data is None:
            continue
        suffix = "_sprint" if args.sprint else ""
        path = os.path.join(OUT_DIR, f"{YEAR}_R{rnd}{suffix}.json")
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        print(f"  wrote {path}  ({len(data['drivers'])} drivers)")
        if args.sprint:
            continue  # sprint files aren't part of the race-pace index/leakage chain
        index.append({"round": rnd, "event": data["event"], "date": data["date"],
                      "file": f"{YEAR}_R{rnd}.json"})

    # merge into index.json (keep prior entries for rounds we didn't refetch)
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
