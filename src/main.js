// main.js - app bootstrap for the full interactive simulator (simulator.html).
//
// Loads the JSON data (constants, track outline, grid) and hands off to the UI controller,
// which owns state, the controls, the GA run, and the playhead-driven renderers.
//
// Data-driven by round: reads ?round=N&driver=CODE from the URL (set by the predictions page's
// Simulate button) so any completed round, or the upcoming one, can be opened here with that
// driver already selected. No params falls back to the upcoming British GP, matching the
// original standalone behaviour.

import { initUI } from './ui.js';
import { resolveCompounds } from './compounds.js';
import { aggregatePace, carPaceByCode, carPaceArray } from './pace.js';

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

// Fetch that returns null instead of throwing (for the per-round pace files, some of which may not
// exist for every round). Lets the caller skip missing rounds cleanly.
async function loadJSONOptional(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Build the leakage-safe per-car pace array (carId -> seconds added per lap), IDENTICAL to what the
// predictions page / calibrate pipeline use: aggregate only rounds STRICTLY BEFORE the target round
// (round 1 => everyone flat), plus this weekend's own Sprint if present (earlier same weekend, so not
// a leak), then tilt by the target track's corner share. Returns an array indexed by carId (driver
// identity in gridData.drivers), so it follows the driver regardless of how the grid is reordered.
async function buildCarPace(round, raceMeta, gridData) {
  const prior = [];
  for (let r = 1; r < round; r++) {
    const pj = await loadJSONOptional(`./data/pace/2026_R${r}.json`);
    if (pj) prior.push(pj);
  }
  const sprint = await loadJSONOptional(`./data/pace/2026_R${round}_sprint.json`);
  if (sprint) prior.push(sprint);
  if (!prior.length) return null; // round 1 (or no data): flattened pace, engine treats null as 0
  const cornerShare = raceMeta?.corner_time_share ?? 0.35;
  const cpByCode = carPaceByCode(aggregatePace(prior), cornerShare);
  return carPaceArray(cpByCode, gridData.drivers.map((d) => d.code));
}

// Build a grid.json-shaped object {drivers, default_grid, source} from a completed round's real
// strategy file (which has the real grid/team/driver name per car) plus team colours borrowed
// from grid.json (colours don't change mid-season, so this round's cars can reuse them).
async function buildHistoricalGrid(round, raceMeta, teamColorByName) {
  const strat = await loadJSON(`./data/strategies/2026_R${round}.json`);
  const entrants = strat.drivers.filter((d) => d.code).sort((a, b) => (a.grid ?? 99) - (b.grid ?? 99));
  const drivers = entrants.map((d) => ({
    code: d.code, name: d.driver, team: d.team, color: teamColorByName[d.team] || '#999999',
  }));
  return {
    drivers, default_grid: drivers.map((_, i) => i),
    source: `${raceMeta.event} real qualifying/grid order`,
  };
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const requestedRound = parseInt(params.get('round'), 10);
  const presetCode = params.get('driver');

  const [constants, gridJson, races] = await Promise.all([
    loadJSON('./data/constants.json'),
    loadJSON('./data/grid.json'),
    loadJSON('./data/races.json').catch(() => ({ races: [] })),
  ]);

  const round = races.races?.some((r) => r.round === requestedRound) ? requestedRound : 9;
  const raceMeta = races.races?.find((r) => r.round === round) || races.races?.find((r) => r.round === 9);
  const teamColorByName = Object.fromEntries(gridJson.drivers.map((d) => [d.team, d.color]));

  const [track, gridData] = await Promise.all([
    loadJSON(`./data/${raceMeta.track_file}`),
    round === 9 ? gridJson : buildHistoricalGrid(round, raceMeta, teamColorByName),
  ]);

  if (raceMeta.total_laps) constants.total_laps = raceMeta.total_laps;
  if (raceMeta.base_lap_seconds) constants.base_lap_seconds = raceMeta.base_lap_seconds;
  if (raceMeta.pit_loss_seconds) constants.pit_loss_seconds = raceMeta.pit_loss_seconds;

  // Resolve this round's real Pirelli allocation into track-accurate pace/deg, same as the
  // calibrate/ reports and predictions.html, so a "soft" means the same thing everywhere on the
  // site.
  const compoundAlloc = raceMeta ? resolveCompounds(raceMeta, constants) : null;

  // Real per-car pace (leakage-safe), same as the predictions page. Keep num_cars in sync with the
  // actual entrant count so the engine's per-car loops match the carPace/strategies arrays.
  constants.num_cars = gridData.drivers.length;
  const carPace = await buildCarPace(round, raceMeta, gridData);

  const presetCarId = presetCode ? gridData.drivers.findIndex((d) => d.code === presetCode) : -1;

  document.title = `F1 Strategy Simulator - ${raceMeta.event}`;
  const subEl = document.getElementById('header-sub');
  if (subEl) subEl.textContent = `${raceMeta.event} - ${round === 9 ? 'upcoming' : 'completed'} - interactive GA demo`;

  // Circuit picker: switching a track reloads with the new round param, reusing all the loading
  // above (grid, track outline, per-track constants and compound allocation). Keep the currently
  // selected driver if there is one so the same car stays chosen across circuits.
  const roundSel = document.getElementById('round-select');
  if (roundSel && races.races?.length) {
    roundSel.innerHTML = '';
    for (const rm of [...races.races].sort((a, b) => a.round - b.round)) {
      const opt = document.createElement('option');
      opt.value = String(rm.round);
      opt.textContent = `R${rm.round}: ${rm.event}`;
      roundSel.appendChild(opt);
    }
    roundSel.value = String(round);
    roundSel.addEventListener('change', () => {
      const params = new URLSearchParams();
      params.set('round', roundSel.value);
      if (presetCode) params.set('driver', presetCode);
      location.search = params.toString();
    });
  }

  const state = initUI({
    constants, track, gridData, compoundAlloc, carPace,
    presetCarId: presetCarId >= 0 ? presetCarId : null,
    autoRun: presetCarId >= 0,
  });

  // Expose for quick console poking during development.
  window.__f1 = { constants, track, gridData, races, compoundAlloc, carPace, state };
  console.log('[F1 sim] boot OK');
}

boot().catch((err) => {
  console.error('[F1 sim] boot FAILED', err);
  const statusEl = document.getElementById('status');
  if (statusEl) statusEl.textContent = `Boot failed: ${err.message} (see console)`;
});
