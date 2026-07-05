// dp.js, Dynamic Programming strategy optimiser (spec section 14.2), replacing the GA as the
// primary v2 optimiser.
//
// IMPORTANT (per explicit product direction): this optimises ONE chosen driver's own strategy
// against their own pace model. It NEVER reasons about the grid/field jointly, there is no
// "optimal grid", only "best strategy for driver X". Traffic/overtaking/undercut interaction with
// the other 21 cars is deliberately NOT part of the DP's objective; that's what the Monte-Carlo
// refinement step (evaluateStrategy in ga.js, run separately per candidate) is for. Call this once
// per driver, exactly like recommendDriver already does with the GA.
//
// For each stop-count k in {1,2,3,4}, enumerate every legal, tyre-allocation-feasible compound
// sequence (k+1 stints) and find the EXACT optimal stop laps via DP (state = stint index + lap,
// objective = minimise the chosen driver's own total race time: base pace + fuel burn + compound
// pace offset/degradation, plus pit-loss per stop). This directly answers "best 1-stop / best
// 2-stop / best 3-stop / best 4-stop", which a single GA population conflates.
//
// The per-lap cost model mirrors engine.js's own lapTime formula exactly (same fuel sign
// convention, same compound fields) so DP's ranking matches what the engine will actually
// simulate; only the field-interaction terms (overtaking, dirty air, safety car) are absent here.

const STOP_COUNTS = [1, 2, 3, 4];

function legalSequences(nStints, legal, weather, setCap) {
  // All legal-compound sequences of length nStints, filtered by: DRY needs >=2 distinct
  // compounds; every compound's total stint-count across the sequence must fit its tyre-set cap.
  const seqs = [];
  const build = (prefix) => {
    if (prefix.length === nStints) {
      if (weather === 'DRY' && new Set(prefix).size < 2) return;
      const used = {};
      for (const c of prefix) used[c] = (used[c] || 0) + 1;
      for (const c of Object.keys(used)) if (used[c] > (setCap[c] ?? Infinity)) return;
      seqs.push(prefix.slice());
      return;
    }
    for (const c of legal) { prefix.push(c); build(prefix); prefix.pop(); }
  };
  build([]);
  return seqs;
}

// Exact DP over stop laps for one fixed compound sequence. Returns { stops, cost } or null if the
// sequence can't legally fit (e.g. every stint would exceed its compound's cliff length).
function optimiseStopLaps(sequence, totalLaps, prefBase, compoundsCfg, pitLoss) {
  const nStints = sequence.length;
  const maxStint = sequence.map((c) => compoundsCfg[c]?.max_stint_laps ?? Infinity);
  const paceOffset = sequence.map((c) => compoundsCfg[c]?.pace_offset ?? 0);
  const deg = sequence.map((c) => compoundsCfg[c]?.deg_per_lap ?? 0);

  const stintCost = (i, start, end) => {
    const length = end - start;
    return (prefBase[end] - prefBase[start]) + paceOffset[i] * length + deg[i] * (length * (length - 1) / 2);
  };

  // dp[i][lap] = min remaining cost, starting stint i at absolute lap `lap` (0-indexed).
  const dp = Array.from({ length: nStints + 1 }, () => new Array(totalLaps + 1).fill(Infinity));
  const choice = Array.from({ length: nStints + 1 }, () => new Array(totalLaps + 1).fill(-1));
  dp[nStints][totalLaps] = 0;

  for (let i = nStints - 1; i >= 0; i--) {
    const stintsAfter = nStints - 1 - i; // stints still needed after this one
    for (let lap = 0; lap <= totalLaps - 1 - stintsAfter; lap++) {
      if (i === nStints - 1) {
        const end = totalLaps;
        const len = end - lap;
        if (len < 1 || len > maxStint[i]) continue;
        dp[i][lap] = stintCost(i, lap, end);
        choice[i][lap] = end;
        continue;
      }
      const maxEnd = Math.min(lap + maxStint[i], totalLaps - stintsAfter);
      for (let end = lap + 1; end <= maxEnd; end++) {
        if (dp[i + 1][end] === Infinity) continue;
        const cand = stintCost(i, lap, end) + pitLoss + dp[i + 1][end];
        if (cand < dp[i][lap]) { dp[i][lap] = cand; choice[i][lap] = end; }
      }
    }
  }

  if (dp[0][0] === Infinity) return null;
  const stops = [];
  let lap = 0;
  for (let i = 0; i < nStints - 1; i++) { lap = choice[i][lap]; stops.push(lap); }
  return { stops, cost: dp[0][0] };
}

// Best strategy per stop-count (1..4) for one driver, purely on their own pace model.
// constants: the round's resolved constants (compounds already track-adjusted by strategy_lib).
export function dpBestPerStopCount({ constants, chosenCarId, weather, carPace = null }) {
  const totalLaps = constants.total_laps;
  const legal = constants.weather[weather].allowed;
  const weatherOffset = constants.weather[weather].offset_seconds;
  const carPaceOffset = carPace ? (carPace[chosenCarId] || 0) : 0;
  const setCap = constants.tyre_allocation || {};
  // Mirrors engine.js's own pit-loss exactly (pit_loss_seconds + pit_realism_seconds cold-tyre/
  // rejoin-risk tax), so DP's own-pace cost ranks stop-counts the same way the actual race engine
  // would, without pit_realism_seconds, deg-time convexity in stint length would make an exact
  // optimiser always prefer more/shorter stints purely because the clock says it's free.
  const pitLoss = constants.pit_loss_seconds + (constants.pit_realism_seconds || 0);

  // basePace[idx] for absolute lap (idx+1), independent of compound/age (fuel + flat offsets).
  const basePace = new Array(totalLaps);
  for (let idx = 0; idx < totalLaps; idx++) {
    const lapsRemaining = totalLaps - (idx + 1);
    basePace[idx] = constants.base_lap_seconds + carPaceOffset + weatherOffset
      + constants.fuel_coeff_seconds_per_lap * lapsRemaining;
  }
  const prefBase = new Array(totalLaps + 1).fill(0);
  for (let i = 0; i < totalLaps; i++) prefBase[i + 1] = prefBase[i] + basePace[i];

  const byStopCount = {};
  for (const k of STOP_COUNTS) {
    const nStints = k + 1;
    if (nStints > totalLaps) continue;
    const sequences = legalSequences(nStints, legal, weather, setCap);
    let best = null;
    for (const seq of sequences) {
      const res = optimiseStopLaps(seq, totalLaps, prefBase, constants.compounds, pitLoss);
      if (res && (!best || res.cost < best.cost)) best = { stops: res.stops, compounds: seq, cost: res.cost };
    }
    if (best) byStopCount[k] = best;
  }

  let overall = null;
  for (const k of STOP_COUNTS) {
    const cand = byStopCount[k];
    if (cand && (!overall || cand.cost < overall.cost)) overall = { ...cand, stopCount: k };
  }
  return { byStopCount, best: overall };
}
