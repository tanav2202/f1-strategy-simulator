// pace.js, turn real FastF1 per-car pace (data/pace/*.json) into `carPace` deltas the engine uses.
//
// LEAKAGE RULE: to predict race N, only ever pass pace rounds STRICTLY BEFORE N. Round 1 has no
// prior data, so every car gets 0 (flattened), that is why Round 1 is the weakest prediction.
//
// Two signals per car come from the data:
//   - pace_delta_s      : overall clean-air race-pace deficit vs the best car (reliable magnitude)
//   - corner/straight_delta_s : where that time is lost (fast-lap telemetry split; the "character")
// We use pace_delta as the base gap, then tilt it by the car's corner-vs-straight bias according to
// how corner-heavy the TARGET track is versus the average of the tracks we measured. So a
// corner-strong car gains at a corner-heavy circuit and vice-versa (spec section 13 reweighting).

const CORNER_SENS = 3.0; // how strongly a track's corner emphasis amplifies a car's corner/straight bias

// Shrinkage strength for the pace estimate: with only n prior rounds averaged, a driver's raw
// pace_delta_s is noisy (an unusually clean or messy race or two can look like a real pace gap).
// SHRINK_K prior "rounds" worth of pull toward the field mean, shrink factor = n / (n + SHRINK_K).
// At n=1 that's 25%, at n=8 it's 73%, so early-season predictions stay conservative and later ones
// trust the data more. Found this was needed after early rounds (2-4 prior races) were producing
// carPace gaps of 0.6-0.7s/lap between plausible rivals, large enough that one driver won nearly
// every simulated race and everyone else, including the pole sitter, showed 0%. Real F1 pace gaps
// between competitive cars are rarely that large; the gap was a small-sample artifact, not signal.
const SHRINK_K = 2;

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Aggregate prior-round pace JSONs into per-driver-code means + the mean corner-time share.
export function aggregatePace(paceRounds) {
  const acc = {};
  const shares = [];
  for (const r of paceRounds) {
    if (typeof r.corner_time_share === 'number') shares.push(r.corner_time_share);
    for (const [code, v] of Object.entries(r.drivers || {})) {
      const a = acc[code] || (acc[code] = { pace: [], corner: [], straight: [] });
      if (typeof v.pace_delta_s === 'number') a.pace.push(v.pace_delta_s);
      if (typeof v.corner_delta_s === 'number') a.corner.push(v.corner_delta_s);
      if (typeof v.straight_delta_s === 'number') a.straight.push(v.straight_delta_s);
    }
  }
  const drivers = {};
  for (const [code, a] of Object.entries(acc)) {
    drivers[code] = { pace: mean(a.pace), corner: mean(a.corner), straight: mean(a.straight), n: a.pace.length };
  }
  return { drivers, cornerShareMean: shares.length ? mean(shares) : 0.3, rounds: paceRounds.length };
}

// Per-driver-code carPace (seconds added per lap) for a target track. `targetCornerShare` is the
// fraction of the target lap spent cornering (a pre-known track property, not a race result).
// Returns { CODE: seconds } with the fastest car ~0 and everyone else positive (slower).
export function carPaceByCode(agg, targetCornerShare) {
  const { drivers, cornerShareMean } = agg;
  const rawPaces = Object.values(drivers).map((d) => d.pace).filter((x) => x != null);
  if (!rawPaces.length) return {}; // no prior data, all flat (Round 1)
  const fieldMean = mean(rawPaces);
  // Shrink each driver's estimate toward the field mean before ranking, so a gap built on only a
  // few rounds can't look as confident as one built on many.
  const shrunk = {};
  for (const [code, d] of Object.entries(drivers)) {
    if (d.pace == null) { shrunk[code] = null; continue; }
    const w = d.n / (d.n + SHRINK_K);
    shrunk[code] = fieldMean + (d.pace - fieldMean) * w;
  }
  const shrunkPaces = Object.values(shrunk).filter((x) => x != null);
  const minPace = Math.min(...shrunkPaces);
  const tilt = (targetCornerShare ?? cornerShareMean) - cornerShareMean; // >0 if target is corner-heavier than average
  const out = {};
  for (const [code, d] of Object.entries(drivers)) {
    const base = shrunk[code] != null ? shrunk[code] - minPace : 0;                  // seconds off the pace (>=0)
    const bias = d.corner != null && d.straight != null ? d.corner - d.straight : 0; // >0 = weaker in corners
    out[code] = base + CORNER_SENS * tilt * bias;
  }
  return out;
}

// Convenience: build a carPace ARRAY indexed by carId, given the grid's driver code per carId.
export function carPaceArray(cpByCode, codesByCarId) {
  return codesByCarId.map((code) => cpByCode[code] ?? 0);
}
