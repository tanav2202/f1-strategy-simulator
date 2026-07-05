// strategy_lib.mjs, shared core for the pre-race (recommend) and post-race (review) reports.
// One place to change the model; both scripts import from here.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateStrategy } from '../src/ga.js';
import { dpBestPerStopCount } from '../src/dp.js';
import { aggregatePace, carPaceByCode, carPaceArray } from '../src/pace.js';
import { resolveCompounds } from '../src/compounds.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const readJSON = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
export const exists = (p) => existsSync(path.join(ROOT, p));

export function driverMeta() {
  const g = readJSON('data/grid.json');
  return {
    metaByCode: Object.fromEntries(g.drivers.map((d) => [d.code, d])),
    teamByCode: Object.fromEntries(g.drivers.map((d) => [d.code, d.team])),
    gridMeta: g,
  };
}

// Build everything needed to simulate/optimise a round, leakage-safe (pace from rounds < round).
export function buildRoundContext(round) {
  const baseConstants = readJSON('data/constants.json');
  const { metaByCode, teamByCode, gridMeta } = driverMeta();
  const races = exists('data/races.json') ? readJSON('data/races.json').races : [];
  const raceMeta = races.find((r) => r.round === round);

  let codesByCarId, eventName, totalLaps;
  if (exists(`data/strategies/2026_R${round}.json`)) {
    const strat = readJSON(`data/strategies/2026_R${round}.json`);
    const entrants = strat.drivers.filter((d) => d.code).sort((a, b) => (a.grid ?? 99) - (b.grid ?? 99));
    codesByCarId = entrants.map((d) => d.code);
    eventName = strat.event; totalLaps = strat.total_laps;
  } else {
    codesByCarId = gridMeta.default_grid.map((id) => gridMeta.drivers[id].code);
    eventName = raceMeta?.event || `Round ${round}`;
    totalLaps = raceMeta?.total_laps || baseConstants.total_laps;
  }
  const cornerShare = raceMeta?.corner_time_share ?? 0.35;
  const baseLap = raceMeta?.base_lap_seconds ?? baseConstants.base_lap_seconds;

  const prior = [];
  for (let r = 1; r < round; r++) if (exists(`data/pace/2026_R${r}.json`)) prior.push(readJSON(`data/pace/2026_R${r}.json`));
  const priorRaceCount = prior.length;
  // Same-weekend sprint pace (if this round ran a sprint) is NOT a leakage violation, it's data
  // from earlier the same race weekend, exactly what a real strategist has in hand pre-race. Added
  // alongside (not instead of) prior full-race rounds, so with 8 prior races + 1 sprint it gets a
  // natural ~1/9 weight in the unweighted aggregatePace mean, a fair "bonus signal", not a
  // dominant one, given it's a single, shorter (fewer-lap) session.
  const usedSprintPace = exists(`data/pace/2026_R${round}_sprint.json`);
  if (usedSprintPace) prior.push(readJSON(`data/pace/2026_R${round}_sprint.json`));
  const cpByCode = carPaceByCode(aggregatePace(prior), cornerShare);

  const n = codesByCarId.length;
  const grid = codesByCarId.map((_, i) => i);
  const teamOf = codesByCarId.map((c) => teamByCode[c] ?? c);
  const carPace = carPaceArray(cpByCode, codesByCarId);
  const constants = JSON.parse(JSON.stringify(baseConstants));
  constants.num_cars = n; constants.total_laps = totalLaps; constants.base_lap_seconds = baseLap;
  // Pit-lane time-loss per round (seconds), sourced in data/races.json: track-specific, short
  // pit lanes (Canada, Monaco) lose less, long ones (China/Japan) more. Round 9 (Silverstone) has
  // a direct source, Pirelli's own preview states pit lane time there as 23s (see references.html).
  constants.pit_loss_seconds = raceMeta?.pit_loss_seconds ?? constants.pit_loss_seconds;
  // Resolve the track's REAL Pirelli compound allocation (hard/medium/soft -> C1..C5) and rewrite
  // the soft/medium/hard pace_offset + deg from the absolute compound_model, so the numbers are
  // track-accurate: a "soft" at Silverstone (C3) is durable, a "soft" at Austria (C5) degrades fast.
  // We deliberately use the monotonic model rather than the per-race measured deg, the measured
  // slopes are too noisy and sometimes invert the ordering (softs run short), which stacked soft
  // stints. See data/constants.json compound_model and data/races.json compounds/tyre_severity.
  const compoundAlloc = resolveCompounds(raceMeta, constants);

  return { baseConstants, constants, eventName, totalLaps, codesByCarId, grid, teamOf, carPace,
    priorRounds: priorRaceCount, usedSprintPace, metaByCode, teamByCode, n, compoundAlloc };
}

const meanFinish = (fc) => { let s = 0, t = 0; fc.forEach((c, p) => { s += c * (p + 1); t += c; }); return t ? s / t : null; };
const topK = (fc, k) => { const t = fc.reduce((a, b) => a + b, 0); return t ? fc.slice(0, k).reduce((a, b) => a + b, 0) / t : 0; };

// Downside percentile (spec 14.3): the finishing position such that `pct` fraction of runs are
// AT LEAST that good or better (e.g. downsidePctl(fc, 0.9) = "90% of the time I finish P<=this").
function downsidePctl(fc, pct) {
  const t = fc.reduce((a, b) => a + b, 0);
  if (!t) return null;
  let cum = 0;
  for (let p = 0; p < fc.length; p++) { cum += fc[p]; if (cum / t >= pct) return p + 1; }
  return fc.length;
}

// Win probability is a proportion estimated from a finite number of Monte Carlo runs, so a "0%"
// from 200 runs doesn't mean truly impossible, it means somewhere under about 1.8%. Report a 95%
// Wilson score interval alongside the point estimate instead of a bare number that reads as false
// certainty at the extremes. Wilson (not the normal approximation) because it behaves correctly
// right at p=0 or p=1, where a naive interval would go negative or over 100%.
function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

// Optimise ONE driver's strategy, spec 14.2/14.3. Per explicit product direction this NEVER
// reasons about the grid jointly: DP finds the exact best stop-laps per stop-count (1..4) against
// ONLY this driver's own pace model, tyre-legal and set-allocation-feasible; each stop-count
// candidate is then Monte-Carlo refined (evaluateStrategy, same engine used everywhere else) to
// account for traffic/undercut/noise/safety-car against the field, and the candidates are ranked
// by expected (mean) finish, the DP replaces the GA as the v2 primary optimiser (spec 14.2); the
// GA itself is untouched and still powers the v1 browser app.
export function recommendDriver(ctx, carId, weather, mc = {}) {
  const dp = dpBestPerStopCount({ constants: ctx.constants, chosenCarId: carId, weather, carPace: ctx.carPace });
  const mcOpts = { constants: ctx.constants, grid: ctx.grid, chosenCarId: carId, weather,
    teamOf: ctx.teamOf, carPace: ctx.carPace, baseSeed: 1000, ...mc };

  const candidates = [];
  for (const k of [1, 2, 3, 4]) {
    const cand = dp.byStopCount[k];
    if (!cand) continue; // infeasible stop-count at this track (tyre life can't stretch that far)
    const strategy = { stops: cand.stops, compounds: cand.compounds };
    const ev = evaluateStrategy({ ...mcOpts, chosenStrategy: strategy, N: mcOpts.screenN ?? 30 });
    candidates.push({ stopCount: k, strategy, expFinish: meanFinish(ev.finishCounts), pWin: ev.p_win, finishCounts: ev.finishCounts });
  }
  if (!candidates.length) throw new Error(`No feasible strategy for carId=${carId} weather=${weather}`);
  // Rank by expected finish (spec 14.3's stated ranking rule); ties broken by win probability.
  candidates.sort((a, b) => (a.expFinish - b.expFinish) || (b.pWin - a.pWin));
  const chosen = candidates[0];

  // Re-evaluate the chosen candidate at higher N for a stable headline + distribution.
  const finalN = mcOpts.finalN ?? 200;
  const finalEv = evaluateStrategy({ ...mcOpts, chosenStrategy: chosen.strategy, N: finalN });

  const code = ctx.codesByCarId[carId];
  const alloc = ctx.compoundAlloc;
  const SHORT = { hard: 'H', medium: 'M', soft: 'S' };
  const compoundsC = alloc ? chosen.strategy.compounds.map((l) => alloc.byLabel[l] || null) : null;
  const plan = alloc
    ? chosen.strategy.compounds.map((l) => `${alloc.byLabel[l]}(${SHORT[l] || l[0].toUpperCase()})`).join('→')
    : chosen.strategy.compounds.join('→');

  // Per-stop-count summary (all evaluated candidates), for "here's what we considered" reporting.
  const byStopCountSummary = candidates
    .map((c) => ({ stopCount: c.stopCount, plan: c.strategy.compounds.join('→'), expFinish: c.expFinish, pWin: c.pWin }))
    .sort((a, b) => a.stopCount - b.stopCount);

  const wins = Math.round(finalEv.p_win * finalEv.N);
  const pWinCI = wilsonInterval(wins, finalEv.N);

  return {
    start: carId + 1, code, name: ctx.metaByCode[code]?.name || code, team: ctx.teamByCode[code] || '',
    stops: chosen.strategy.stops.length,
    compounds: chosen.strategy.compounds,
    compoundsC,
    plan,
    pits: chosen.strategy.stops,
    expFinish: meanFinish(finalEv.finishCounts),
    pWin: finalEv.p_win,
    pWinLo: pWinCI.lo, pWinHi: pWinCI.hi, // 95% Wilson interval, see wilsonInterval() above
    top5: topK(finalEv.finishCounts, 5),
    finishCounts: finalEv.finishCounts,
    downsideP90: downsidePctl(finalEv.finishCounts, 0.9), // "9 times in 10, I finish P<=this or better"
    byStopCount: byStopCountSummary,
  };
}

// Recommend for every driver (or a subset). Strictly per-driver: each call to recommendDriver
// optimises that one driver's strategy independently, there is no joint/grid-level pass here.
export function recommendRound(round, weather, onlyDrivers = null, mc = {}) {
  const ctx = buildRoundContext(round);
  const rows = [];
  for (let carId = 0; carId < ctx.n; carId++) {
    const code = ctx.codesByCarId[carId];
    if (onlyDrivers && !onlyDrivers.includes(code)) continue;
    rows.push(recommendDriver(ctx, carId, weather, mc));
    process.stderr.write(`  ${code} done\n`);
  }
  return { ctx, rows };
}
