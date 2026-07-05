// recommend.mjs, PRE-RACE strategy calls: "had I been each driver's strategist, here's the plan."
//
// Uses the SHARED core (strategy_lib.mjs) so it is identical to the post-race review's logic.
// Leakage-safe: optimises every driver's strategy using only prior-round pace, and writes a clean,
// postable markdown report. Repeatable every weekend, one command.
//
//   node calibrate/recommend.mjs --round 9                     # British GP (grid.json quali order)
//   node calibrate/recommend.mjs --round 9 --weather DRY --drivers ANT,HAM,NOR
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { recommendRound, readJSON, ROOT } from './strategy_lib.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const round = parseInt(getArg('--round', '9'), 10);
const weather = getArg('--weather', 'DRY');
const onlyDrivers = getArg('--drivers', null)?.split(',').map((s) => s.trim().toUpperCase()) || null;

const { ctx, rows } = recommendRound(round, weather, onlyDrivers);
const legal = ctx.baseConstants.weather[weather].allowed.join('/');
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

let md = `# ${ctx.eventName} 2026, pre-race strategy calls\n\n`;
md += `*"Had I been their strategist…"*, generated **${now}**, BEFORE the race.\n\n`;
md += `- **Weather assumed:** ${weather} (${legal}) · **${ctx.totalLaps} laps**\n`;
if (ctx.compoundAlloc) {
  const a = ctx.compoundAlloc;
  md += `- **Pirelli compounds (official):** Soft **${a.byLabel.soft}** · Medium **${a.byLabel.medium}** · Hard **${a.byLabel.hard}**`;
  md += `, tyre severity ×${a.severity}. Calls below name the real compound (e.g. C3(S)).\n`;
}
md += `- **Model:** each driver's strategy optimised for *their own* finish, vs a field with `;
md += ctx.priorRounds ? `**real per-car pace** calibrated on 2026 rounds 1–${round - 1} (leakage-safe)${ctx.usedSprintPace ? ` + this weekend's own Sprint session` : ''}.` : `flat pace (no prior data).`;
md += `\n- **Validation:** backtested on completed 2026 races, rank-corr ρ≈0.64. A **recommendation, not a winner prediction**.\n\n`;
md += `| Start | Driver | Team | My call | Pit window | Exp. finish | Win% (95% range) | Top-5% |\n`;
md += `|------:|--------|------|---------|-----------|:----------:|:----:|:-----:|\n`;
for (const r of rows) {
  const winStr = `${(r.pWin * 100).toFixed(0)}% (${(r.pWinLo * 100).toFixed(0)}-${(r.pWinHi * 100).toFixed(0)}%)`;
  md += `| P${r.start} | **${r.code}** ${r.name.split(' ').slice(-1)[0]} | ${r.team} | ${r.stops}-stop ${r.plan} | ${r.pitWindowStr || 'none'} | P${r.expFinish.toFixed(1)} | ${winStr} | ${(r.top5 * 100).toFixed(0)}% |\n`;
}
const oneStop = rows.filter((r) => r.stops === 1).length;
const twoStop = rows.filter((r) => r.stops === 2).length;
md += `\n## Read of the race\n`;
md += `- Field split: **${oneStop} one-stoppers, ${twoStop} two-stoppers**, ${rows.length - oneStop - twoStop} other.\n`;
md += `- Front-runners' calls protect track position; midfield calls chase the undercut.\n\n`;
md += `## Limitations (read this)\n`;
md += `- **Safety cars ARE modelled** (a per-lap chance of a full-course caution that reshuffles the pit windows and feeds the win%). **Not modelled:** retirements/DNFs, red flags, human error (driver mistakes, pit-crew errors, mechanical failures), and mid-race weather changes, still the biggest real-world swings.\n`;
md += `- Pace is from **prior races only**; per-track pit-loss is approximated. Compounds now respect the real 2H/3M/8S set allocation and a per-compound cliff length, but the cliff numbers are our sourced technical estimate, not an official rule (no universal FIA max-stint rule exists).\n`;
md += `- Rivals run a *reactive* strategy model, not their real plans. Win% comes from injected execution noise plus the safety-car draw, not real bookmaker odds, and it is conditioned on one simulated rival field.\n`;
md += `- A strategy **toy**, deliberately honest about its assumptions. Post-race review to follow.\n`;

mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
const out = path.join(ROOT, 'reports', `2026_R${round}_prerace.md`);
writeFileSync(out, md);
console.log(md);
process.stderr.write(`\nWrote ${path.relative(ROOT, out)}\n`);
