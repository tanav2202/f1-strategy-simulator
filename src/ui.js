// ui.js, grid setup, controls, wiring, playhead (spec sections 8 & 9).
//
// Owns app state and the DOM: the draggable grid, the car picker, the weather picker, the run
// button (kicks off the GA), the results readout, and the replay controls that drive a single
// fractional playhead shared by both canvas renderers.

import { evolveStrategy, findBestCaseRun } from './ga.js';
import { renderTrace } from './render-trace.js';
import { renderMap } from './render-map.js';

// Playback speed in laps/second for each speed setting (spec asks for 1x and 10x minimum).
// 1x = one lap every 10 seconds (0.1 laps/s → ~8.7 min for the full 52-lap race) so every
// overtake and undercut is easy to follow; 10x (~52s) and 20x (~26s) are for a quicker watch.
// Labels are nominal, true real-time would be ~90s PER lap.
const LAPS_PER_SEC = { 1: 0.1, 10: 1, 20: 2 };

export function initUI({ constants, track, gridData, compoundAlloc = null, carPace = null, presetCarId = null, autoRun = false }) {
  const drivers = gridData.drivers;
  // Real Pirelli C-number for a soft/medium/hard label, e.g. "soft" -> "C3" at Silverstone
  // (falls back to the plain label if this track has no resolved allocation).
  const cName = (label) => (compoundAlloc?.byLabel?.[label] ? `${compoundAlloc.byLabel[label]}` : label.toUpperCase());
  const totalLaps = constants.total_laps;
  const teamOf = drivers.map((d) => d.team); // carId -> team, for the pit double-stack rule

  const state = {
    order: gridData.default_grid.slice(), // carIds in P1..P22 order
    chosenCarId: presetCarId ?? gridData.default_grid[0],
    weather: 'DRY',
    result: null,   // GA result
    race: null,     // stored best-case run for replay
    lap: 0,         // fractional playhead
    playing: false,
    speed: 1,
    running: false,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    gridList: $('grid-list'), useDefault: $('use-default'), weather: $('weather'),
    run: $('run'), results: $('results'), status: $('status'),
    play: $('play'), scrub: $('scrub'), lapLabel: $('lap-label'),
    trace: $('trace'), map: $('map'), leaderboard: $('leaderboard'), lbTitle: $('lb-title'),
    caption: $('replay-caption'),
    intro: $('intro'), introClose: $('intro-close'), helpBtn: $('help-btn'),
  };

  // Onboarding modal: shown on every load (per request), reopenable via the header "?" button.
  els.introClose.addEventListener('click', () => { els.intro.hidden = true; });
  els.helpBtn.addEventListener('click', () => { els.intro.hidden = false; });
  els.intro.addEventListener('click', (e) => { if (e.target === els.intro) els.intro.hidden = true; });
  els.intro.hidden = false;
  const traceCtx = els.trace.getContext('2d');
  const mapCtx = els.map.getContext('2d');

  // -------------------------------------------------------------------------
  // Grid list (drag to reorder, click to choose your car)
  // -------------------------------------------------------------------------
  let dragCarId = null;

  function renderGrid() {
    els.gridList.innerHTML = '';
    state.order.forEach((carId, i) => {
      const d = drivers[carId];
      const li = document.createElement('li');
      li.className = 'grid-row' + (carId === state.chosenCarId ? ' chosen' : '');
      li.draggable = true;
      li.dataset.carId = String(carId);
      li.innerHTML =
        `<span class="pos">P${i + 1}</span>` +
        `<span class="swatch" style="background:${d.color}"></span>` +
        `<span class="code">${d.code}</span>` +
        `<span class="name">${d.name} <span class="team">${d.team}</span></span>` +
        (carId === state.chosenCarId ? `<span class="you">You</span>` : '');

      li.addEventListener('click', () => { state.chosenCarId = carId; renderGrid(); markStale(); });
      li.addEventListener('dragstart', (e) => {
        dragCarId = carId; li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => { dragCarId = null; li.classList.remove('dragging'); });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragCarId === null || dragCarId === carId) return;
        const from = state.order.indexOf(dragCarId);
        const to = state.order.indexOf(carId);
        state.order.splice(from, 1);
        state.order.splice(to, 0, dragCarId);
        renderGrid();
        markStale();
      });
      els.gridList.appendChild(li);
    });
  }

  els.useDefault.addEventListener('click', () => {
    state.order = gridData.default_grid.slice();
    renderGrid();
    markStale();
  });

  // -------------------------------------------------------------------------
  // Weather picker
  // -------------------------------------------------------------------------
  function renderWeather() {
    els.weather.innerHTML = '';
    for (const w of Object.keys(constants.weather)) {
      const b = document.createElement('button');
      b.textContent = w;
      if (w === state.weather) b.classList.add('active');
      b.addEventListener('click', () => { state.weather = w; renderWeather(); markStale(); });
      els.weather.appendChild(b);
    }
  }

  // When inputs change after a run, mark the shown result as stale.
  function markStale() {
    if (state.result && !state.running) {
      els.status.innerHTML = '<strong>Inputs changed</strong>, run again to refresh the strategy.';
    }
  }

  // -------------------------------------------------------------------------
  // Run the GA
  // -------------------------------------------------------------------------
  els.run.addEventListener('click', () => {
    if (state.running) return;
    state.running = true;
    state.playing = false;
    els.run.disabled = true;
    els.run.textContent = 'Searching…';
    els.status.innerHTML = 'Running genetic search (Monte-Carlo over execution noise)…';
    // Yield once so the "Searching…" state paints before the (blocking) GA runs.
    setTimeout(runSearch, 30);
  });

  function runSearch() {
    const chosenCarId = state.chosenCarId;
    const weather = state.weather;
    const t0 = performance.now();

    const result = evolveStrategy({ constants, grid: state.order, chosenCarId, weather, teamOf, carPace });
    const best = findBestCaseRun({
      constants, grid: state.order, chosenCarId, weather, chosenStrategy: result.strategy, teamOf, carPace,
    });
    const ms = Math.round(performance.now() - t0);

    state.result = result;
    state.race = best.race;
    state.bestFinish = best.finishPos;
    state.lap = 0;
    state.running = false;
    els.run.disabled = false;
    els.run.textContent = 'Run strategy search';

    // Grid slot per car, for the live "places vs grid" column.
    state.startPosOf = {};
    best.race.finish.forEach((f) => { state.startPosOf[f.carId] = f.startPos; });
    lastLbLap = -1;

    // Honest caption: the replay is the single luckiest of `best.N` runs, so contextualise it with
    // the driver's actual win probability (measured over the GA's final Monte-Carlo sample).
    const pct = result.p_win * 100;
    const pctStr = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    els.caption.hidden = false;
    els.caption.innerHTML =
      `<span class="rc-tag">Luckiest of ${best.N} runs</span>` +
      `<span>${drivers[chosenCarId].name}'s real win chance:</span>` +
      `<span class="rc-odds">${pctStr}%</span>` +
      `<span class="rc-note">,  this replay is the best case, not the typical one.</span>`;

    renderResults();
    els.status.innerHTML = `<strong>Done</strong> in ${ms}ms · best-case replay: ${drivers[chosenCarId].code} finishes P${best.finishPos + 1}. Press play.`;
    setLap(0);
    play(); // auto-play the replay
  }

  function renderResults() {
    const r = state.result;
    const d = drivers[state.chosenCarId];
    const startPos = state.order.indexOf(state.chosenCarId);
    const gained = r.expected_positions_gained;
    const gainedStr = (gained >= 0 ? '+' : '') + gained.toFixed(1);
    const chips = r.strategy.compounds
      .map((c) => `<span class="chip" style="background:${constants.compounds[c].color}">${cName(c)}</span>`)
      .join('<span style="color:var(--muted)"> → </span>');
    els.results.className = 'results';
    els.results.innerHTML =
      `<div class="stat"><span>Your car</span><b>${d.code} · ${d.name}</b></div>` +
      `<div class="stat"><span>Start</span><b>P${startPos + 1}</b></div>` +
      `<div class="stat"><span>Win probability</span><b class="big">${(r.p_win * 100).toFixed(0)}%</b></div>` +
      `<div class="stat"><span>Expected positions gained</span><b>${gainedStr}</b></div>` +
      `<div class="stat"><span>Recommended stops</span><b>lap ${r.strategy.stops.join(', ')}</b></div>` +
      `<div class="chips">${chips}</div>`;
  }

  // LIVE running order at the current lap of the best-case replay. Rebuilt only when the integer
  // lap changes (so it tracks the playhead without thrashing the DOM every frame). Each row shows
  // the car's tyre stints SO FAR (coloured, in order), stops so far, live gap to the leader, and
  // places gained/lost vs its grid slot. This makes the whole race legible, you can watch every
  // rival's strategy unfold and see exactly how the order was won.
  let lastLbLap = -1;

  function tyreLegend() {
    const legal = constants.weather[state.weather].allowed;
    const swatches = legal
      .map((c) => `<span class="tyre" style="background:${constants.compounds[c].color}"></span>${cName(c)}`)
      .join('&nbsp;&nbsp;');
    return `<li class="lb-legend">Tyres, stint order →&nbsp; ${swatches} &nbsp;·&nbsp; ▲/▼ places vs grid</li>`;
  }

  function renderLeaderboard(lap, force = false) {
    const race = state.race;
    if (!race) return;
    const T = constants.total_laps;
    const L = Math.max(0, Math.min(Math.floor(lap), T));
    if (!force && L === lastLbLap) return;
    lastLbLap = L;

    const snap = race.laps[L];
    const order = [...Array(drivers.length).keys()].sort((a, b) => snap[a].cumTime - snap[b].cumTime);
    const leaderTime = snap[order[0]].cumTime;

    els.lbTitle.innerHTML =
      `Best-case scenario, <strong style="color:var(--ink)">${drivers[state.chosenCarId].name}</strong> ` +
      `<span style="color:var(--muted)">· lap ${L}/${T}${L === T ? ' (finish)' : ''}</span>`;

    els.leaderboard.innerHTML = tyreLegend();
    order.forEach((carId, pos) => {
      const d = drivers[carId];
      const pits = race.executedPits[carId].filter((pl) => pl <= L);
      const comps = [race.laps[0][carId].compound, ...pits.map((pl) => race.laps[pl][carId].compound)];
      const tyres = comps
        .map((c) => `<span class="tyre" style="background:${constants.compounds[c].color}" title="${cName(c)}"></span>`)
        .join('<span class="tyre-arrow">›</span>');
      const delta = state.startPosOf[carId] - pos; // + = up vs grid
      const gap = pos === 0 ? 'Leader' : `+${(snap[carId].cumTime - leaderTime).toFixed(1)}s`;
      const dcls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const dtxt = delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : '–';
      const li = document.createElement('li');
      li.className = 'lb-row' + (carId === state.chosenCarId ? ' chosen' : '');
      li.innerHTML =
        `<span class="lb-pos">P${pos + 1}</span>` +
        `<span class="lb-code">${d.code}</span>` +
        `<span class="lb-name">${d.team}</span>` +
        `<span class="lb-tyres">${tyres}</span>` +
        `<span class="lb-stops">${pits.length}-stop</span>` +
        `<span class="lb-gap">${gap}</span>` +
        `<span class="lb-delta ${dcls}">${dtxt}</span>`;
      els.leaderboard.appendChild(li);
    });
  }

  // -------------------------------------------------------------------------
  // Replay controls + playhead
  // -------------------------------------------------------------------------
  els.scrub.max = String(totalLaps);
  els.scrub.addEventListener('input', () => { pause(); setLap(parseFloat(els.scrub.value)); });
  els.play.addEventListener('click', () => (state.playing ? pause() : play()));
  document.querySelectorAll('.speed').forEach((b) => {
    b.addEventListener('click', () => {
      state.speed = parseInt(b.dataset.speed, 10);
      document.querySelectorAll('.speed').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  function setLap(lap) {
    state.lap = Math.max(0, Math.min(lap, totalLaps));
    els.scrub.value = String(state.lap);
    els.lapLabel.textContent = `Lap ${Math.min(Math.ceil(state.lap), totalLaps)} / ${totalLaps}`;
    draw();
  }

  function play() {
    if (!state.race) return;
    if (state.lap >= totalLaps) state.lap = 0; // restart if at end
    state.playing = true;
    els.play.textContent = '❚❚';
    lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
  function pause() {
    state.playing = false;
    els.play.textContent = '▶';
  }

  let lastFrame = 0;
  function tick(now) {
    if (!state.playing) return;
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    let lap = state.lap + dt * LAPS_PER_SEC[state.speed];
    if (lap >= totalLaps) { lap = totalLaps; pause(); }
    setLap(lap);
    if (state.playing) requestAnimationFrame(tick);
  }

  // Size a canvas's backing store to its displayed size × devicePixelRatio (capped at 2 to bound
  // cost) for crisp rendering on retina/phone screens, and scale the context so drawing code works
  // in logical CSS pixels. Returns the logical {W, H} for the renderers.
  function sizeCanvas(canvas, ctx) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { W, H };
  }
  function sizeAll() {
    state.dims = { trace: sizeCanvas(els.trace, traceCtx), map: sizeCanvas(els.map, mapCtx) };
  }

  function draw() {
    if (!state.race) { drawIdle(); return; }
    const common = { race: state.race, drivers, chosenCarId: state.chosenCarId, lap: state.lap, constants };
    renderTrace(traceCtx, { ...common, W: state.dims.trace.W, H: state.dims.trace.H });
    renderMap(mapCtx, { ...common, track, W: state.dims.map.W, H: state.dims.map.H });
    renderLeaderboard(state.lap); // live running order at the current lap
  }

  function drawIdle() {
    for (const [ctx, dims, label] of [[traceCtx, state.dims.trace, 'Race trace'], [mapCtx, state.dims.map, 'Map']]) {
      const w = dims.W, h = dims.H;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#3a1a1b'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
      ctx.strokeRect(12, 12, w - 24, h - 24); ctx.setLineDash([]);
      ctx.fillStyle = '#e10600'; ctx.fillRect(w / 2 - 18, h / 2 - 34, 36, 4);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
      ctx.font = '600 15px -apple-system, sans-serif';
      ctx.fillText(label, w / 2, h / 2 - 8);
      ctx.fillStyle = '#b0a6a8'; ctx.font = '12px -apple-system, sans-serif';
      ctx.fillText('Run the search to generate a replay', w / 2, h / 2 + 12);
    }
  }

  // Re-size and redraw on viewport changes (orientation, resize), debounced.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { sizeAll(); draw(); }, 150);
  });

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  renderGrid();
  renderWeather();
  sizeAll();
  drawIdle(); // placeholder art until the first run
  els.status.innerHTML =
    `<strong>Ready.</strong> Default grid: ${gridData.source} (pole ${drivers[gridData.default_grid[0]].code}).`;

  // Arrived here from the predictions page with a specific driver already chosen: skip the
  // onboarding modal and kick the search off right away instead of waiting for another click.
  if (autoRun && presetCarId != null) {
    els.intro.hidden = true;
    els.run.click();
  }

  return state;
}
