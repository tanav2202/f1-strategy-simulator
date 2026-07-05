// backtest_accuracy.mjs, how accurate is our race model?
//
// For each completed round N (calibrating pace from rounds < N only, no leakage), we feed EVERY
// car's REAL strategy (actual pit laps + compounds) into our engine with our calibrated per-car
// pace, run it many times (execution noise), and compare the simulated finishing order to the
// REAL finishing order. This isolates model accuracy from strategy search: if real strategies +
// our pace reproduce the real result, our model is good.
//
// Metrics per round (among cars that actually finished):
//   - winner correct?           did the car we rank P1 actually win
//   - podium hits /3            how many of our top-3 were real top-3
//   - Spearman rho              rank correlation of predicted vs actual order
//   - mean |position error|     average how many places off per car
//
// Run:  node calibrate/backtest_accuracy.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulateRace } from '../src/engine.js';
import { aggregatePace, carPaceByCode, carPaceArray } from '../src/pace.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJSON = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const baseConstants = readJSON('data/constants.json');
const teamByCode = Object.fromEntries(readJSON('data/grid.json').drivers.map((d) => [d.code, d.team]));
const strategyIndex = readJSON('data/strategies/index.json').rounds;
const NRUNS = 15;

function detectWeather(strat) {
  let wet = 0, total = 0;
  for (const d of strat.drivers) for (const s of d.stints) { total++; if (s.compound === 'intermediate' || s.compound === 'wet') wet++; }
  const frac = total ? wet / total : 0;
  return frac > 0.5 ? 'WET' : frac > 0.15 ? 'DAMP' : 'DRY';
}

// Fixed strategy from a driver's real stints (compounds + stop laps at stint boundaries).
function fixedStrategyFromStints(d) {
  const stints = (d.stints || []).filter((s) => s.compound);
  if (!stints.length) return null;
  const compounds = stints.map((s) => s.compound);
  const stops = stints.slice(1).map((s) => s.lap_start);
  return { stops, compounds };
}

function spearman(aRank, bRank) {
  const n = aRank.length;
  if (n < 2) return null;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (aRank[i] - bRank[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function backtestRound(round) {
  const strat = readJSON(`data/strategies/2026_R${round}.json`);
  const paceThis = readJSON(`data/pace/2026_R${round}.json`);

  const prior = [];
  for (let r = 1; r < round; r++) {
    const p = `data/pace/2026_R${r}.json`;
    if (existsSync(path.join(ROOT, p))) prior.push(readJSON(p));
  }
  const cpByCode = carPaceByCode(aggregatePace(prior), paceThis.corner_time_share);

  // entrants that have a usable real strategy; carId = grid slot
  const entrants = strat.drivers
    .filter((d) => d.code && fixedStrategyFromStints(d))
    .slice()
    .sort((a, b) => (a.grid ?? 99) - (b.grid ?? 99));
  const n = entrants.length;
  if (n < 6) return null;

  const codesByCarId = entrants.map((d) => d.code);
  const grid = codesByCarId.map((_, i) => i);
  const teamOf = codesByCarId.map((c) => teamByCode[c] ?? c);
  const carPace = carPaceArray(cpByCode, codesByCarId);
  const strategies = entrants.map(fixedStrategyFromStints);
  const weather = detectWeather(strat);
  const constants = JSON.parse(JSON.stringify(baseConstants));
  constants.num_cars = n; constants.total_laps = strat.total_laps;
  // No simulated safety cars here: the real result already embeds its own race's SC effects,
  // so injecting random ones would only blur the pace-model comparison (spec section 14.6).
  delete constants.safety_car;
  // Use this track's real per-compound degradation (a pre-known track/practice property).
  for (const [c, v] of Object.entries(paceThis.deg_per_lap_s || {})) {
    if (constants.compounds[c] && v > 0) constants.compounds[c].deg_per_lap = v;
  }

  // average finishing time per car over NRUNS noise seeds
  const sumTime = new Array(n).fill(0);
  for (let i = 0; i < NRUNS; i++) {
    const res = simulateRace({ constants, weather, strategies, grid, seed: 1000 + i * 7919, teamOf, carPace });
    for (const f of res.finish) sumTime[f.carId] += f.cumTime;
  }
  const predOrder = [...Array(n).keys()].sort((a, b) => sumTime[a] - sumTime[b]); // carIds fastest->slowest

  // score only among cars that actually FINISHED (real classified position)
  const actualFinishers = entrants
    .map((d, carId) => ({ carId, finish: d.finish }))
    .filter((x) => x.finish != null)
    .sort((a, b) => a.finish - b.finish);
  const finisherSet = new Set(actualFinishers.map((x) => x.carId));
  const predFinishers = predOrder.filter((c) => finisherSet.has(c)); // our predicted order among them

  const actualRankByCar = {};
  actualFinishers.forEach((x, i) => (actualRankByCar[x.carId] = i));
  const predRankByCar = {};
  predFinishers.forEach((c, i) => (predRankByCar[c] = i));

  const cars = actualFinishers.map((x) => x.carId);
  const aRank = cars.map((c) => actualRankByCar[c]);
  const pRank = cars.map((c) => predRankByCar[c]);
  const meanPosErr = cars.reduce((s, c) => s + Math.abs(actualRankByCar[c] - predRankByCar[c]), 0) / cars.length;

  const winnerCorrect = predFinishers[0] === actualFinishers[0].carId;
  const predTop3 = new Set(predFinishers.slice(0, 3));
  const podiumHits = actualFinishers.slice(0, 3).filter((x) => predTop3.has(x.carId)).length;

  return {
    round, event: strat.event, weather, priorRounds: prior.length, n: cars.length,
    winnerCorrect, podiumHits, rho: spearman(aRank, pRank), meanPosErr,
  };
}

console.log(`Race-model accuracy backtest (real strategies + leakage-safe calibrated pace, ${NRUNS} runs/race)\n`);
console.log('Rnd  Event                     Wx    prior  N   winner  podium/3   rho     mean|posErr|');
console.log('-'.repeat(92));
const rows = [];
for (const { round } of strategyIndex) {
  const r = backtestRound(round);
  if (!r) { console.log(`${String(round).padStart(2)}   (skipped)`); continue; }
  rows.push(r);
  console.log(
    `${String(r.round).padStart(2)}   ${r.event.padEnd(24)} ${r.weather.padEnd(5)} ${String(r.priorRounds).padStart(2)}    ${String(r.n).padStart(2)}  ` +
    `${(r.winnerCorrect ? '  ✓  ' : '  ✗  ')}   ${r.podiumHits}/3       ${(r.rho ?? 0).toFixed(2).padStart(5)}   ${r.meanPosErr.toFixed(2)}`
  );
}
// averages over rounds that had prior data (round >= 2)
const withPrior = rows.filter((r) => r.priorRounds > 0);
const avg = (f) => withPrior.reduce((s, r) => s + f(r), 0) / withPrior.length;
console.log('-'.repeat(92));
console.log(`AVG (rounds with prior data, n=${withPrior.length}):  winner ${(100 * avg((r) => r.winnerCorrect ? 1 : 0)).toFixed(0)}%   ` +
  `podium ${avg((r) => r.podiumHits).toFixed(1)}/3   rho ${avg((r) => r.rho ?? 0).toFixed(2)}   mean|posErr| ${avg((r) => r.meanPosErr).toFixed(2)}`);
