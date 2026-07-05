// backtest_all.mjs - runs the leakage-safe per-driver recommender against every completed 2026
// round (R1-R8) and writes a human-readable consolidated report plus the machine-readable JSON
// behind the web app's "what we called vs what actually happened" view.
//
// Per-driver, always: each round's recommendation is built by recommendRound (strategy_lib.mjs),
// which calls recommendDriver independently for each car. No grid-level or joint optimisation.
//
// Two accuracy metrics, both excluding drivers who "Did not start" or "Retired" (a partial race
// naturally needs fewer stops than a full-length prediction, so comparing the two isn't a fair
// test of the model):
//   - stop-count agreement: did we call the right number of stops?
//   - compound-choice agreement: did we call the right SET of compounds (order/count aside)?
//
// Usage: node calibrate/backtest_all.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { recommendRound, readJSON, exists, ROOT } from './strategy_lib.mjs';

const ROUNDS = [1, 2, 3, 4, 5, 6, 7, 8];
const SHORT = { hard: 'H', medium: 'M', soft: 'S' };

function detectWeather(strat) {
  let wet = 0, tot = 0;
  for (const d of strat.drivers) for (const s of d.stints) { tot++; if (s.compound === 'intermediate' || s.compound === 'wet') wet++; }
  return tot && wet / tot > 0.5 ? 'WET' : tot && wet / tot > 0.15 ? 'DAMP' : 'DRY';
}
function nameComp(alloc, l) {
  return alloc && alloc.byLabel[l] ? `${alloc.byLabel[l]}(${SHORT[l] || l[0].toUpperCase()})` : l;
}
function sameSet(a, b) {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

const roundResults = [];

for (const round of ROUNDS) {
  if (!exists(`data/strategies/2026_R${round}.json`)) { console.error(`R${round}: no strategy data, skipping`); continue; }
  const strat = readJSON(`data/strategies/2026_R${round}.json`);
  const weather = detectWeather(strat);
  process.stderr.write(`R${round} ${strat.event} (${weather})...\n`);

  const { ctx, rows } = recommendRound(round, weather);
  const recByCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  const alloc = ctx.compoundAlloc;

  const actualByCode = {};
  for (const d of strat.drivers) {
    const rawCompounds = d.stints.map((s) => s.compound).filter(Boolean);
    const raced = d.status === 'Finished' || d.status === 'Lapped';
    actualByCode[d.code] = { stops: d.stops, rawCompounds, plan: rawCompounds.map((l) => nameComp(alloc, l)).join('→'), finish: d.finish, grid: d.grid, status: d.status, raced };
  }

  const drivers = [];
  let stopMatches = 0, compoundMatches = 0, counted = 0;
  const ordered = strat.drivers.filter((d) => d.finish != null).sort((a, b) => a.finish - b.finish);
  for (const d of ordered) {
    const rec = recByCode[d.code]; const act = actualByCode[d.code];
    if (!rec) continue;
    const comparable = act.raced;
    const stopMatch = comparable ? rec.stops === act.stops : null;
    const compoundMatch = comparable ? sameSet(rec.compounds, act.rawCompounds) : null;
    if (comparable) { counted++; if (stopMatch) stopMatches++; if (compoundMatch) compoundMatches++; }
    drivers.push({
      code: d.code, name: rec.name, team: rec.team,
      actualFinish: d.finish, actualGrid: act.grid, actualStatus: act.status,
      predictedStops: rec.stops, predictedPlan: rec.plan, predictedPits: rec.pits, predictedExpFinish: rec.expFinish, predictedPWin: rec.pWin,
      actualStops: act.stops, actualPlan: act.plan,
      stopCountCorrect: stopMatch, compoundCorrect: compoundMatch,
    });
  }

  roundResults.push({
    round, event: strat.event, date: strat.date, totalLaps: strat.total_laps, weather,
    priorRounds: ctx.priorRounds,
    compoundAllocation: alloc ? { hard: alloc.byLabel.hard, medium: alloc.byLabel.medium, soft: alloc.byLabel.soft, severity: alloc.severity } : null,
    stopCountAgreement: { correct: stopMatches, total: counted },
    compoundAgreement: { correct: compoundMatches, total: counted },
    drivers,
  });
}

// --- Write machine-readable JSON for the web app ---
mkdirSync(path.join(ROOT, 'data'), { recursive: true });
writeFileSync(path.join(ROOT, 'data', 'backtest_results.json'), JSON.stringify({ generated_utc: new Date().toISOString(), rounds: roundResults }, null, 2));

// --- Write human-readable consolidated summary ---
let md = `# 2026 backtest results: recommended vs actual, every completed round\n\n`;
md += `Leakage-safe: each round's recommendation uses only pace from rounds before it (round 1 has none). `;
md += `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC.\n\n`;
md += `What this model does know about: safety cars are simulated (a per-lap chance of a full-course caution that reshuffles pit windows). What it does NOT know about: retirements/DNFs, red-flag stoppages, human error (driver mistakes, pit-crew errors, mechanical failures), and live weather transitions mid-race. Drivers who retired or did not start are excluded from the accuracy counts below (a partial race isn't a fair comparison against a full-race prediction), though they're still listed in each round's table.\n\n`;
md += `| Rnd | Event | Weather | Prior rounds used | Stop-count agreement | Compound agreement |\n|----:|-------|:-------:|:------------------:|:---------------------:|:---------------------:|\n`;
let sumCorrect = 0, sumTotal = 0, sumCompCorrect = 0;
for (const r of roundResults) {
  md += `| R${r.round} | ${r.event} | ${r.weather} | ${r.priorRounds} | ${r.stopCountAgreement.correct}/${r.stopCountAgreement.total} | ${r.compoundAgreement.correct}/${r.compoundAgreement.total} |\n`;
  sumCorrect += r.stopCountAgreement.correct; sumTotal += r.stopCountAgreement.total; sumCompCorrect += r.compoundAgreement.correct;
}
md += `\nOverall: ${sumCorrect}/${sumTotal} (${sumTotal ? Math.round(100 * sumCorrect / sumTotal) : 0}%) stop-count agreement, ${sumCompCorrect}/${sumTotal} (${sumTotal ? Math.round(100 * sumCompCorrect / sumTotal) : 0}%) compound-choice agreement, across all classified drivers, all rounds (retirees and non-starters excluded from both).\n\n`;

for (const r of roundResults) {
  md += `\n## R${r.round}: ${r.event}${r.compoundAllocation ? ` (soft ${r.compoundAllocation.soft}, medium ${r.compoundAllocation.medium}, hard ${r.compoundAllocation.hard}, severity x${r.compoundAllocation.severity})` : ''}\n\n`;
  md += `| Fin | Driver | My call | They ran | Stops match | Compounds match |\n|----:|--------|---------|----------|:---:|:---:|\n`;
  for (const d of r.drivers) {
    const statusNote = d.actualStatus && d.actualStatus !== 'Finished' && d.actualStatus !== 'Lapped' ? ` (${d.actualStatus})` : '';
    const stopMark = d.stopCountCorrect === null ? 'n/a' : d.stopCountCorrect ? 'yes' : 'no';
    const compMark = d.compoundCorrect === null ? 'n/a' : d.compoundCorrect ? 'yes' : 'no';
    md += `| P${d.actualFinish}${statusNote} | **${d.code}** | ${d.predictedStops}-stop ${d.predictedPlan} | ${d.actualStops}-stop ${d.actualPlan} | ${stopMark} | ${compMark} |\n`;
  }
}

mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
writeFileSync(path.join(ROOT, 'reports', 'backtest_all_rounds.md'), md);
console.log(`\nOverall stop-count agreement: ${sumCorrect}/${sumTotal}, compound agreement: ${sumCompCorrect}/${sumTotal}`);
console.log(`Wrote data/backtest_results.json and reports/backtest_all_rounds.md`);
