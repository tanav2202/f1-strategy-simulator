// generate_predictions.mjs - builds data/predictions.json, the dataset behind the "race day
// predictions" page (predictions.html) for every 2026 round, completed or upcoming.
//
// Per-driver, always: recommendRound calls recommendDriver independently for each car (DP+MC,
// spec 14.2/14.3). There is no grid-level or joint optimisation anywhere in this pipeline.
//
// For completed rounds we also embed the actual strategy, finish, and two correctness flags:
// stop-count match and compound-choice match (same compounds used, regardless of order or how
// many stops). Drivers who "Did not start" never get compared (there's no strategy to compare).
// Drivers who "Retired" mid-race are shown but excluded from the accuracy totals too, since a
// partial race naturally needs fewer stops than a full-length prediction assumed; comparing the
// two isn't a fair test of the model, it's just a fact about when the car broke or crashed.
//
// Usage: node calibrate/generate_predictions.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { recommendRound, readJSON, exists, ROOT } from './strategy_lib.mjs';

const races = readJSON('data/races.json').races;
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

const out = [];

for (const race of races) {
  const round = race.round;
  const hasStrategy = exists(`data/strategies/2026_R${round}.json`);
  const strat = hasStrategy ? readJSON(`data/strategies/2026_R${round}.json`) : null;
  const weather = strat ? detectWeather(strat) : 'DRY';
  process.stderr.write(`R${round} ${race.event} (${weather}, ${hasStrategy ? 'completed' : 'upcoming'})...\n`);

  const { ctx, rows } = recommendRound(round, weather);
  const alloc = ctx.compoundAlloc;

  const actualByCode = {};
  if (strat) {
    for (const d of strat.drivers) {
      const rawCompounds = d.stints.map((s) => s.compound).filter(Boolean);
      const raced = d.status === 'Finished' || d.status === 'Lapped';
      actualByCode[d.code] = {
        stops: d.stops, rawCompounds, plan: rawCompounds.map((l) => nameComp(alloc, l)).join('→'),
        finish: d.finish, grid: d.grid, status: d.status, raced,
      };
    }
  }

  const drivers = [];
  let stopMatches = 0, compoundMatches = 0, counted = 0;
  for (const r of rows) {
    const act = actualByCode[r.code] || null;
    const comparable = act && act.raced; // exclude DNS and retirements from accuracy
    const stopCorrect = comparable ? r.stops === act.stops : null;
    const compoundCorrect = comparable ? sameSet(r.compounds, act.rawCompounds) : null;
    if (comparable) { counted++; if (stopCorrect) stopMatches++; if (compoundCorrect) compoundMatches++; }
    drivers.push({
      code: r.code, name: r.name, team: r.team, start: r.start,
      predicted: {
        stops: r.stops, plan: r.plan, pits: r.pits, compounds: r.compounds, compoundsC: r.compoundsC,
        expFinish: r.expFinish, pWin: r.pWin, pWinLo: r.pWinLo, pWinHi: r.pWinHi, top5: r.top5, downsideP90: r.downsideP90,
        byStopCount: r.byStopCount,
      },
      actual: act ? { stops: act.stops, plan: act.plan, finish: act.finish, grid: act.grid, status: act.status, raced: act.raced } : null,
      stopCountCorrect: stopCorrect,
      compoundCorrect,
    });
  }
  drivers.sort((a, b) => (a.actual?.finish ?? a.start) - (b.actual?.finish ?? b.start));

  out.push({
    round, event: race.event, date: race.date, totalLaps: ctx.totalLaps, weather,
    status: hasStrategy ? 'completed' : 'upcoming',
    trackFile: race.track_file,
    priorRounds: ctx.priorRounds, usedSprintPace: ctx.usedSprintPace,
    compoundAllocation: alloc ? { hard: alloc.byLabel.hard, medium: alloc.byLabel.medium, soft: alloc.byLabel.soft, severity: alloc.severity } : null,
    stopCountAgreement: hasStrategy ? { correct: stopMatches, total: counted } : null,
    compoundAgreement: hasStrategy ? { correct: compoundMatches, total: counted } : null,
    drivers,
  });
}

mkdirSync(path.join(ROOT, 'data'), { recursive: true });
writeFileSync(path.join(ROOT, 'data', 'predictions.json'), JSON.stringify({ generated_utc: new Date().toISOString(), rounds: out }, null, 2));
console.log(`Wrote data/predictions.json (${out.length} rounds)`);
