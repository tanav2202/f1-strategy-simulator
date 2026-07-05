"""
Regenerate data/tracks/2026_R{n}.json at HIGH fidelity from real FastF1 GPS position telemetry, dense enough (400 points) that the outline shows genuine corner geometry with no artificial
smoothing needed downstream (render-map.js no longer Catmull-Rom-smooths these).

Does NOT touch data/races.json (which now also carries hand-curated compound/severity fields), only overwrites the track outline JSON files. Run after extract_circuits.py has already populated
data/races.json once.

Also fetches a REAL Silverstone outline for the upcoming British GP (2026 R9, not yet run) from the
prior year's race at the same permanent circuit (2025 British Grand Prix), a genuine GPS trace is
strictly better than the hand-drawn approximation it replaces.

Run:  /Users/tanav/miniforge3/envs/f1-calibrate/bin/python calibrate/extract_track_outlines.py
"""
import os
import json

import numpy as np
import fastf1

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "calibrate", "cache")
TRACK_DIR = os.path.join(ROOT, "data", "tracks")
N_POINTS = 400  # dense enough that real corners read correctly with plain line segments


def circuit_outline(session, n_points=N_POINTS):
    candidates = []
    try:
        candidates.append(session.laps.pick_fastest())
    except Exception:
        pass
    for drv in session.laps["Driver"].dropna().unique():
        try:
            candidates.append(session.laps.pick_drivers(drv).pick_fastest())
        except Exception:
            pass

    for lap in candidates:
        try:
            tel = lap.get_telemetry()
            if "X" not in tel.columns:
                continue
            x = tel["X"].values.astype(float)
            y = tel["Y"].values.astype(float)
            if len(x) < 20 or (x.max() - x.min()) == 0:
                continue
            idx = np.linspace(0, len(x) - 1, min(n_points, len(x))).astype(int)
            x, y = x[idx], y[idx]
            sx = (x.max() - x.min()) or 1.0
            sy = (y.max() - y.min()) or 1.0
            return [[round(float((xi - x.min()) / sx), 5), round(float(1 - (yi - y.min()) / sy), 5)] for xi, yi in zip(x, y)]
        except Exception:
            continue
    raise RuntimeError("no usable position telemetry")


def write_outline(rnd, name, points, source):
    track = {"name": name, "round": rnd, "closed": True, "points": points, "_source": source}
    path = os.path.join(TRACK_DIR, f"2026_R{rnd}.json")
    with open(path, "w") as f:
        json.dump(track, f)
    print(f"  wrote {path} ({len(points)} points)")


def main():
    fastf1.Cache.enable_cache(CACHE)
    os.makedirs(TRACK_DIR, exist_ok=True)

    completed_rounds = [1, 2, 3, 4, 5, 7, 8]
    for rnd in completed_rounds:
        try:
            s = fastf1.get_session(2026, rnd, "R")
            s.load(laps=True, telemetry=True, weather=False, messages=False)
            pts = circuit_outline(s)
            write_outline(rnd, str(s.event["EventName"]), pts,
                          f"FastF1 position telemetry, fastest lap, {N_POINTS}pt (2026 R{rnd} real race)")
        except Exception as e:
            print(f"  R{rnd} FAILED: {type(e).__name__}: {e}")

    # R6 (Monaco) was left out of races.json originally: the 2026 race's cached position data has
    # a parsing issue (KeyError on 'Date') that breaks outline extraction entirely, not just a
    # "hasn't run yet" gap. Monaco's permanent circuit doesn't change, so fall back to a real prior
    # year's GPS trace rather than leaving the round with no map at all.
    try:
        s = fastf1.get_session(2026, 6, "R")
        s.load(laps=True, telemetry=True, weather=False, messages=False)
        pts = circuit_outline(s)
        write_outline(6, "Monaco Grand Prix", pts, f"FastF1 position telemetry, fastest lap, {N_POINTS}pt (2026 R6 real race)")
    except Exception as e:
        print(f"  R6 outline FAILED: {type(e).__name__}: {e}, falling back to 2025 race")
        try:
            s = fastf1.get_session(2025, "Monaco Grand Prix", "R")
            s.load(laps=True, telemetry=True, weather=False, messages=False)
            pts = circuit_outline(s)
            write_outline(6, "Monaco Grand Prix", pts,
                          f"FastF1 position telemetry, fastest lap, {N_POINTS}pt (2025 Monaco GP, "
                          f"2026 R6's cached position data has a parsing fault; same permanent circuit, real GPS trace)")
        except Exception as e2:
            print(f"  R6 (Monaco) FAILED: {type(e2).__name__}: {e2}")

    # R9 (British GP / Silverstone) main race hasn't run yet in 2026, but this is a sprint
    # weekend, so Saturday's Sprint session already ran on the same 2026-spec car at the same
    # permanent circuit. Prefer that (real, this-year GPS trace) over last year's race.
    try:
        s = fastf1.get_session(2026, 9, "S")
        s.load(laps=True, telemetry=True, weather=False, messages=False)
        pts = circuit_outline(s)
        write_outline(9, "British Grand Prix (Silverstone)", pts,
                      f"FastF1 position telemetry, fastest lap, {N_POINTS}pt (2026 R9 Sprint, "
                      f"the main race hasn't been run yet but the Sprint already has, same weekend)")
    except Exception as e:
        print(f"  R9 Sprint outline FAILED: {type(e).__name__}: {e}, falling back to 2025 race")
        try:
            s = fastf1.get_session(2025, "British Grand Prix", "R")
            s.load(laps=True, telemetry=True, weather=False, messages=False)
            pts = circuit_outline(s)
            write_outline(9, "British Grand Prix (Silverstone)", pts,
                          f"FastF1 position telemetry, fastest lap, {N_POINTS}pt (2025 British GP, "
                          f"2026 R9 hasn't been run yet; same permanent circuit, real GPS trace)")
        except Exception as e2:
            print(f"  R9 (Silverstone preview) FAILED: {type(e2).__name__}: {e2}")


if __name__ == "__main__":
    main()
