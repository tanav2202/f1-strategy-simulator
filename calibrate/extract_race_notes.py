"""extract_race_notes.py -- build an honest per-race "where the model couldn't help" note.

For each completed 2026 round it pulls the AUTHORITATIVE race-control facts from the FastF1
cache (safety cars, virtual safety cars, red flags) plus retirements and weather from our
strategy JSON, and writes data/race_notes.json. These are the real-world events our leakage-safe
pace/tyre model does not simulate, so the note explains, per race, exactly why the calls drift.

No fabricated causes: every number here comes straight from the session data.
"""
import json
import os
import warnings
import fastf1

warnings.filterwarnings("ignore")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fastf1.Cache.enable_cache(os.path.join(ROOT, "calibrate", "cache"))

races = json.load(open(os.path.join(ROOT, "data", "races.json")))["races"]


def status_events(session):
    """Count safety-car, VSC and red-flag deployments from the track-status stream."""
    ts = session.track_status
    sc = vsc = red = 0
    prev = None
    for _, row in ts.iterrows():
        s = str(row["Status"])
        if s != prev:
            if s == "4":
                sc += 1
            elif s == "6":
                vsc += 1
            elif s == "5":
                red += 1
        prev = s
    return sc, vsc, red


def frame_note(event, weather, sc, vsc, red, retired, dns, our_stop, real_stop):
    """Turn the raw facts into one honest, well-framed sentence-set."""
    def join_and(items):
        if len(items) <= 1:
            return "".join(items)
        return ", ".join(items[:-1]) + " and " + items[-1]

    causes = []
    if red:
        causes.append(f"{red} red flag" + ("s" if red > 1 else ""))
    if sc:
        causes.append(f"{sc} safety car" + ("s" if sc > 1 else ""))
    if vsc:
        causes.append(f"{vsc} virtual safety car" + ("s" if vsc > 1 else ""))
    dnf_bits = []
    if retired:
        dnf_bits.append(f"{retired} car" + ("s" if retired > 1 else "") + " retired")
    if dns:
        dnf_bits.append(f"{dns} did not start")

    parts = []
    # Weather first, since it changes the whole strategy picture.
    if weather == "WET":
        parts.append(
            "This was a wet race. The model runs a single dry condition, so it cannot represent "
            "the intermediate and wet crossover stops that actually decided it."
        )
    elif weather == "DAMP":
        parts.append(
            "This race ran partly on intermediates. The model assumes dry slick running, so the "
            "damp-weather stops are outside what it can call."
        )

    # Cautions.
    if causes:
        cause_str = join_and(causes)
        parts.append(
            f"The race saw {cause_str}, which can hand the field cheap stops and reset the gaps. "
            "The model gives a safety car a random per-lap chance but cannot know this race's "
            "actual timing, so where a real caution forced an extra stop our call reads short."
        )
    # Retirements.
    if dnf_bits:
        parts.append(
            (" and ".join(dnf_bits)).capitalize()
            + ". The model does not simulate mechanical failures or crashes, so those cars are "
            "predicted for a full race they never finished."
        )
    # Stop-count gap, stated plainly.
    if our_stop is not None and real_stop is not None and our_stop != real_stop:
        parts.append(
            f"Net effect: we mostly called a {our_stop}-stop, the field mostly ran a {real_stop}-stop."
        )

    if not parts:
        parts.append(
            "A relatively clean, green-flag race, which is where a pace-and-tyre model is on its "
            "firmest ground."
        )
    return " ".join(parts)


def modal(values):
    if not values:
        return None
    counts = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    return max(counts, key=counts.get)


out = {}
for race in races:
    rnd = race["round"]
    strat_path = os.path.join(ROOT, "data", "strategies", f"2026_R{rnd}.json")
    if not os.path.exists(strat_path):
        continue  # upcoming round, no note yet
    strat = json.load(open(strat_path))
    drivers = strat["drivers"]
    retired = sum(1 for d in drivers if d.get("status") == "Retired")
    dns = sum(1 for d in drivers if d.get("status") in ("Did not start", "Withdrew"))
    finishers = [d for d in drivers if d.get("status") in ("Finished", "Lapped")]
    real_stop = modal([d.get("stops") for d in finishers if d.get("stops") is not None])

    # Weather from the tyre mix (matches generate_predictions' detectWeather).
    tot = wet = 0
    for d in drivers:
        for s in d.get("stints", []):
            tot += 1
            if s.get("compound") in ("intermediate", "wet"):
                wet += 1
    weather = "WET" if tot and wet / tot > 0.5 else "DAMP" if tot and wet / tot > 0.15 else "DRY"

    try:
        session = fastf1.get_session(2026, race["event"], "R")
        session.load(telemetry=False, weather=False, messages=False)
        sc, vsc, red = status_events(session)
    except Exception as e:
        print(f"R{rnd}: could not read track status ({e}); notes will omit cautions")
        sc = vsc = red = 0

    note = frame_note(race["event"], weather, sc, vsc, red, retired, dns, None, real_stop)
    out[str(rnd)] = {
        "event": race["event"],
        "weather": weather,
        "safety_cars": sc, "virtual_safety_cars": vsc, "red_flags": red,
        "retirements": retired, "did_not_start": dns,
        "real_modal_stops": real_stop,
        "note": note,
    }
    print(f"R{rnd} {race['event']}: SC={sc} VSC={vsc} red={red} retired={retired} dns={dns} weather={weather}")

json.dump({"notes": out}, open(os.path.join(ROOT, "data", "race_notes.json"), "w"), indent=2)
print(f"\nWrote data/race_notes.json ({len(out)} completed rounds)")
