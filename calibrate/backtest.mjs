// backtest.mjs, leakage-safe backtest of our strategy recommender against what actually happened.
//
// For each completed 2026 round N (in order), we calibrate per-car pace from rounds STRICTLY
// BEFORE N (no leakage, Round 1 gets flat pace), run the GA to recommend a strategy for that
// race's winner, and compare it to the strategy they actually ran. Predictions should improve as
// the season builds. Reuses the app's own engine + GA (src/*.js), no sim is re-implemented.
//
// Run:  node calibrate/backtest.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evolveStrategy } from '../src/ga.js';
import { aggregatePace, carPaceByCode, carPaceArray } from '../src/pace.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJSON = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

const baseConstants = readJSON('data/constants.json');
const gridMeta = readJSON('data/grid.json'); // for team lookup (double-stack rule)
const teamByCode = Object.fromEntries(gridMeta.drivers.map((d) => [d.code, d.team]));

const strategyIndex = readJSON('data/strategies/index.json').rounds;

// Detect the weather a race was run in from the compounds actually used.
function detectWeather(strat) {
  let wet = 0, total = 0;
  for (const d of strat.drivers) for (const s of d.stints) {
    total++;
    if (s.compound === 'intermediate' || s.compound === 'wet') wet++;
  }
  const frac = total ? wet / total : 0;
  return frac > 0.5 ? 'WET' : frac > 0.15 ? 'DAMP' : 'DRY';
}

// Compound sequence a driver actually ran (per stint, in order).
function actualCompounds(driver) {
  return driver.stints.map((s) => s.compound).filter(Boolean);
}

function backtestRound(round) {
  const strat = readJSON(`data/strategies/2026_R${round}.json`);
  const paceThis = readJSON(`data/pace/2026_R${round}.json`); // used ONLY for the track's corner-share (a track property)

  // --- leakage-safe pace: aggregate rounds strictly before this one ---
  const prior = [];
  for (let r = 1; r < round; r++) {
    const p = `data/pace/2026_R${r}.json`;
    if (existsSync(path.join(ROOT, p))) prior.push(readJSON(p));
  }
  const agg = aggregatePace(prior);
  const cpByCode = carPaceByCode(agg, paceThis.corner_time_share);

  // --- build the grid from the real result (carId = grid slot) ---
  const entrants = strat.drivers
    .filter((d) => d.code)
    .slice()
    .sort((a, b) => (a.grid ?? 99) - (b.grid ?? 99));
  const codesByCarId = entrants.map((d) => d.code);
  const n = codesByCarId.length;
  const grid = codesByCarId.map((_, i) => i);
  const teamOf = codesByCarId.map((c) => teamByCode[c] ?? c);
  const carPace = carPaceArray(cpByCode, codesByCarId);

  const weather = detectWeather(strat);
  const constants = { ...baseConstants, num_cars: n, total_laps: strat.total_laps };

  // --- pick the winner and recommend a strategy for them (leakage-safe pace) ---
  const winner = strat.drivers.find((d) => d.finish === 1) || entrants[0];
  const chosenCarId = codesByCarId.indexOf(winner.code);

  const res = evolveStrategy({
    constants, grid, chosenCarId, weather, teamOf, carPace,
    popSize: 20, generations: 8, N: 18, finalN: 60, seed: 7,
  });

  const rec = res.strategy;
  const act = actualCompounds(winner);
  const recCount = rec.stops.length;
  const actCount = winner.stops;
  const stopMatch = recCount === actCount ? '✓' : ' ';

  return {
    round, event: strat.event, weather, priorRounds: agg.rounds,
    winner: winner.code, winnerGrid: winner.grid,
    recStops: recCount, recStrat: rec.compounds.join('>') + ' @ ' + rec.stops.join(','),
    actStops: actCount, actStrat: act.join('>') + ' @ ' + (winner.pit_laps.join(',') || '-'),
    stopMatch, pWin: res.p_win,
  };
}

console.log('Leakage-safe backtest, our recommendation for each race WINNER vs what they actually ran\n');
console.log('Rnd  Event                     Wx    prior  Winner        stops(rec/act)   recommended            actual');
console.log('-'.repeat(120));
for (const { round } of strategyIndex) {
  try {
    const r = backtestRound(round);
    console.log(
      `${String(r.round).padStart(2)}   ${r.event.padEnd(24)} ${r.weather.padEnd(5)} ${String(r.priorRounds).padStart(2)}    ` +
      `${r.winner.padEnd(4)} (P${String(r.winnerGrid).padStart(2)})   ${r.recStops}/${r.actStops} ${r.stopMatch}         ` +
      `${r.recStrat.padEnd(22)} ${r.actStrat}`
    );
  } catch (e) {
    console.log(`${String(round).padStart(2)}   FAILED: ${e.message}`);
  }
}
console.log('\nNote: Round 1 uses no prior data (flat pace) by design; later rounds calibrate on all prior races.');
