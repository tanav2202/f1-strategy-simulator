// predictions.js - the home page: pick any 2026 round, see each driver's DP-optimised strategy
// call (predicted expected finish, win%, downside), and for completed rounds, what they actually
// ran and whether the stop-count and compound-choice calls were correct.
//
// Strictly per-driver throughout: every prediction optimises ONE chosen car against the field.
// Nothing here ever reasons about the grid jointly.
//
// Simulate takes you to the full interactive simulator (simulator.html) with that round's real
// track, grid, and compounds loaded and that driver already selected and running, so you get the
// same rich playhead/trace/map experience as the original Silverstone demo, for whichever race and
// driver you actually picked.

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

const state = { predictions: null, round: null, colorByCode: {} };

const el = (id) => document.getElementById(id);

// "box lap 23" for a single lap, "box laps 21-26" for a window, "box laps 18-22, 40-44" for a
// two-stopper. Falls back to the exact pit laps for older data without a window.
function pitWindowText(p) {
  const str = p.pitWindowStr || (p.pits && p.pits.length ? p.pits.join(', ') : '');
  if (!str) return '';
  const multi = /[-,]/.test(str);
  return `box lap${multi ? 's' : ''} ${str}`;
}

async function boot() {
  const [predictions, grid, notes] = await Promise.all([
    loadJSON('./data/predictions.json'),
    loadJSON('./data/grid.json'),
    loadJSON('./data/race_notes.json').catch(() => ({ notes: {} })),
  ]);
  state.predictions = predictions;
  // Team colour per driver code, so each row in the strategy table carries team identity.
  state.colorByCode = Object.fromEntries(grid.drivers.map((d) => [d.code, d.color]));
  // Per-race honest note on what the model couldn't capture (safety cars, DNFs, weather).
  state.notesByRound = notes.notes || {};

  const sel = el('raceSelect');
  for (const r of predictions.rounds) {
    const opt = document.createElement('option');
    opt.value = r.round;
    opt.textContent = `R${r.round}: ${r.event} (${r.status})`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => selectRound(parseInt(sel.value, 10)));

  // Default to the upcoming round if there is one, otherwise the most recent completed one.
  const upcoming = predictions.rounds.find((r) => r.status === 'upcoming');
  selectRound((upcoming || predictions.rounds[predictions.rounds.length - 1]).round);

  console.log('[predictions] boot OK');
}

function selectRound(round) {
  state.round = round;
  el('raceSelect').value = String(round);
  const r = state.predictions.rounds.find((x) => x.round === round);
  el('statusBadge').textContent = r.status;
  el('statusBadge').className = `status-badge ${r.status}`;
  el('weatherNote').textContent = `${r.weather}, ${r.totalLaps} laps, prior data: ${r.priorRounds} rounds${r.usedSprintPace ? " plus this weekend's Sprint" : ''}`;

  const alloc = r.compoundAllocation;
  el('compoundRow').innerHTML = alloc
    ? `<span class="chip soft">Soft ${alloc.soft}</span><span class="chip medium">Medium ${alloc.medium}</span><span class="chip hard">Hard ${alloc.hard}</span><span class="severity-note">tyre severity x${alloc.severity}</span>`
    : '';

  el('trackTitle').textContent = r.event;
  renderTrackPreview(r.trackFile);
  renderDriverTable(r);
}

async function renderTrackPreview(trackFile) {
  const canvas = el('trackCanvas');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  try {
    const track = await loadJSON(`./data/${trackFile}`);
    const pts = track.points;
    const margin = 24;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
    const scale = Math.min((W - 2 * margin) / spanX, (H - 2 * margin) / spanY);
    const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
    ctx.strokeStyle = '#e10600'; ctx.lineWidth = 2.5; ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const px = offX + (x - minX) * scale, py = offY + (y - minY) * scale;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath(); ctx.stroke();
  } catch (e) {
    ctx.fillStyle = '#9aa0aa'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Track outline unavailable.', W / 2, H / 2);
  }
}

function renderDriverTable(r) {
  const completed = r.status === 'completed';
  // Honest "where the model couldn't help" note for completed races (real safety cars, DNFs, weather
  // the leakage-safe pace model doesn't simulate). Hidden for upcoming rounds.
  const note = state.notesByRound[String(r.round)];
  const noteEl = el('modelNote');
  if (completed && note && note.note) {
    noteEl.hidden = false;
    noteEl.innerHTML = `<b>Where the model couldn't help here:</b> ${note.note}`;
  } else {
    noteEl.hidden = true;
  }
  const stopAcc = r.stopCountAgreement;
  const compAcc = r.compoundAgreement;
  el('accuracyNote').textContent = completed
    ? `Backtest accuracy this round: stop count ${stopAcc.correct}/${stopAcc.total} (${stopAcc.total ? Math.round(100 * stopAcc.correct / stopAcc.total) : 0}%), compound choice ${compAcc.correct}/${compAcc.total} (${compAcc.total ? Math.round(100 * compAcc.correct / compAcc.total) : 0}%). Drivers who retired or didn't start are left out of both counts since a partial race isn't a fair comparison, though they're still listed below.`
    : "Race hasn't run yet, so this is a prediction only. There's nothing to check it against.";
  // Plain-English legend for the metrics, so no column needs decoding.
  el('metricsLegend').innerHTML = completed
    ? 'How to read it: <b>Predicted call</b> = our recommended stops, tyres and pit-lap window · <b>Exp. finish</b> = average finish across simulated runs · <b>Win%</b> = share of runs won · <b>Stops&nbsp;✓ / Compounds&nbsp;✓</b> = did our call match what they actually ran.'
    : 'How to read it: <b>Predicted call</b> = our recommended stops, tyres and pit-lap window · <b>Exp. finish</b> = average finish across simulated runs · <b>Win%</b> = share of runs won (95% range) · <b>Worst case (9-in-10)</b> = the driver finishes this position or better in 9 of every 10 simulated runs.';
  el('tableHead').innerHTML =
    '<th title="Starting position, from Saturday qualifying">Grid (quali)</th>'
    + '<th>Driver</th>'
    + '<th title="Our recommended strategy: number of stops, tyre sequence (real Pirelli C-compounds), and the lap window to pit in">Predicted call</th>'
    + '<th title="Average finishing position across all simulated runs">Exp. finish</th>'
    + '<th title="Share of simulated runs this driver wins, with a 95% confidence range">Win% (95% range)</th>'
    + (completed
      ? '<th title="The strategy the driver actually ran, and where they finished">They ran</th><th title="Did our predicted stop-count match theirs?">Stops&nbsp;✓</th><th title="Did our predicted tyre compounds match theirs?">Compounds&nbsp;✓</th>'
      : '<th title="Realistic worst case: the driver beats or matches this position in 9 of 10 simulated runs; only 1 in 10 is worse">Worst case (9-in-10)</th>')
    + '<th></th>';
  const body = el('tableBody');
  body.innerHTML = '';
  for (const d of r.drivers) {
    const tr = document.createElement('tr');
    const p = d.predicted;
    // A "0%" from a few hundred simulated runs doesn't mean truly impossible, so show the 95%
    // Wilson interval alongside the point estimate rather than a bare number that reads as
    // false certainty at the extremes (see wilsonInterval in strategy_lib.mjs).
    const winPct = Math.round((p.pWin ?? 0) * 100);
    const winRange = p.pWinLo != null ? `<span class="win-range">(${Math.round(p.pWinLo * 100)}-${Math.round(p.pWinHi * 100)}%)</span>` : '';
    const color = state.colorByCode[d.code] || '#999999';
    let cells = `<td>P${d.start}</td>`
      + `<td><span class="driver-cell"><span class="team-bar" style="background:${color}"></span>`
      + `<span><span class="driver-code">${d.code}</span> <span class="driver-name">${d.name}</span>`
      + `<br><span class="win-range">${d.team}</span></span></span></td>`
      + `<td>${p.stops}-stop ${p.plan}`
      + (pitWindowText(p) ? `<br><span class="win-range">${pitWindowText(p)}</span>` : '')
      + `</td><td>P${p.expFinish?.toFixed(1) ?? '?'}</td><td>${winPct}% ${winRange}</td>`;
    if (completed && d.actual) {
      const dnfNote = d.actual.raced === false ? ` (${d.actual.status})` : '';
      const stopMark = d.stopCountCorrect === null ? '&mdash;' : d.stopCountCorrect ? '<span class="match">yes</span>' : '<span class="mismatch">no</span>';
      const compMark = d.compoundCorrect === null ? '&mdash;' : d.compoundCorrect ? '<span class="match">yes</span>' : '<span class="mismatch">no</span>';
      cells += `<td>${d.actual.stops}-stop ${d.actual.plan} (P${d.actual.finish}${dnfNote})</td><td>${stopMark}</td><td>${compMark}</td>`;
    } else if (!completed) {
      cells += `<td>P${p.downsideP90 ?? '?'} or better</td>`;
    } else {
      cells += '<td>&mdash;</td><td>&mdash;</td><td>&mdash;</td>';
    }
    cells += `<td><a class="sim-btn" href="./simulator.html?round=${r.round}&driver=${d.code}">Simulate</a></td>`;
    tr.innerHTML = cells;
    body.appendChild(tr);
  }
}

boot().catch((err) => {
  console.error('[predictions] boot FAILED', err);
});
