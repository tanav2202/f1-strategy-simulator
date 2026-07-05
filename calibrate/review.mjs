// review.mjs, POST-RACE follow-up: how my pre-race calls compared to what teams actually did.
//
// Regenerates the leakage-safe recommendation for a completed round and lines it up against the
// real strategies + results, with a plain-spoken "how different / what I got wrong" section.
//
// Usage:  node calibrate/review.mjs --round 8     (needs data/strategies/2026_R8.json to exist)
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { recommendRound, readJSON, exists, ROOT } from './strategy_lib.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const round = parseInt(getArg('--round', '8'), 10);

if (!exists(`data/strategies/2026_R${round}.json`)) {
  console.error(`No actual strategies for round ${round} yet, run fetch_strategies.py after the race.`);
  process.exit(1);
}
const strat = readJSON(`data/strategies/2026_R${round}.json`);

// weather actually run (from compounds used)
let wet = 0, tot = 0;
for (const d of strat.drivers) for (const s of d.stints) { tot++; if (s.compound === 'intermediate' || s.compound === 'wet') wet++; }
const weather = tot && wet / tot > 0.5 ? 'WET' : tot && wet / tot > 0.15 ? 'DAMP' : 'DRY';

const { ctx, rows } = recommendRound(round, weather);
const recByCode = Object.fromEntries(rows.map((r) => [r.code, r]));

// Annotate a real stint compound with its Pirelli C-number for apples-to-apples comparison.
const alloc = ctx.compoundAlloc;
const SHORT = { hard: 'H', medium: 'M', soft: 'S' };
const nameComp = (l) => (alloc && alloc.byLabel[l] ? `${alloc.byLabel[l]}(${SHORT[l] || l[0].toUpperCase()})` : l);

const actualByCode = {};
for (const d of strat.drivers) {
  const comps = d.stints.map((s) => s.compound).filter(Boolean);
  actualByCode[d.code] = { stops: d.stops, plan: comps.map(nameComp).join('→'), finish: d.finish, grid: d.grid };
}

// markdown
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
let md = `# ${strat.event} 2026, post-race review\n\n`;
md += `*How my pre-race calls compared to reality*, ${now}. Weather run: **${weather}**, ${strat.total_laps} laps.\n\n`;
md += `Recommendations were generated leakage-safe (pace from rounds < ${round} only), exactly as they would have been pre-race.\n\n`;
if (alloc) md += `**Pirelli compounds (official):** Soft **${alloc.byLabel.soft}** · Medium **${alloc.byLabel.medium}** · Hard **${alloc.byLabel.hard}**, severity ×${alloc.severity}.\n\n`;
md += `| Fin | Start | Driver | My call | They ran | Stop match |\n|----:|------:|--------|---------|----------|:---------:|\n`;
let stopMatches = 0, counted = 0;
const ordered = strat.drivers.filter((d) => d.finish != null).sort((a, b) => a.finish - b.finish);
for (const d of ordered) {
  const rec = recByCode[d.code]; const act = actualByCode[d.code];
  if (!rec) continue;
  const match = rec.stops === act.stops;
  if (act.finish != null) { counted++; if (match) stopMatches++; }
  md += `| P${d.finish} | P${act.grid ?? '?'} | **${d.code}** | ${rec.stops}-stop ${rec.plan} | ${act.stops}-stop ${act.plan} | ${match ? '✓' : '✗'} |\n`;
}
md += `\n## How I did\n`;
md += `- **Stop-count agreement: ${stopMatches}/${counted}** of classified drivers.\n`;
const myOneStop = rows.filter((r) => r.stops === 1).length;
const theirOneStop = strat.drivers.filter((d) => d.stops === 1).length;
md += `- I called ${myOneStop} one-stops; teams actually ran ${theirOneStop}.\n`;
md += `\n## What differed & why (limitations)\n`;
md += `- The model simulates safety cars **probabilistically** (a per-lap caution chance), but it cannot know *this* race's actual caution timing, red flags, or DNFs, so where a real incident forced an extra stop it will under-call it.\n`;
md += `- Pace was calibrated on **prior races only**; a team that upgraded or a track that didn't suit them will read wrong.\n`;
md += `- Compounds now use the **real Pirelli C-allocation** for this track (C1–C5), so which tyre is named is credible; the residual uncertainty is the *magnitude* of deg (a monotonic model × per-track severity, not per-compound measured fits) and per-track **pit-loss**.\n`;
md += `- Rivals were modelled reactively, so undercut timing won't match any single real stop exactly.\n`;

mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const out = path.join(ROOT, 'reports', `2026_R${round}_review.md`);
writeFileSync(out, md);
console.log(md);
process.stderr.write(`\nWrote ${path.relative(ROOT, out)}\n`);
