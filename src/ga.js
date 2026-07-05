// ga.js, genetic algorithm for the chosen car only (spec section 7).
//
// This file holds two things:
//   - evaluateStrategy(): the Monte-Carlo evaluator (Milestone 4). Runs the race engine N times
//     against a fixed reactive field, varying only the per-lap execution-noise seed (spec section 2
//     names this the single source of randomness, and it is what makes win probability meaningful).
//   - evolveStrategy(): the GA search over the chosen car's genome (Milestone 5).
//
// A chosen-car strategy (genome) is a FIXED plan the engine follows:
//   { stops: [lap...], compounds: [c0, c1...] }   // compounds length = stops.length + 1

import { simulateRace, makeRng } from './engine.js';
import { makeRivalPolicies } from './field.js';

// Assemble the full per-car strategy array: the chosen car gets its fixed genome, every other car
// gets a reactive rival policy. The field is seeded by `fieldSeed` so it is one fixed, reproducible
// field realisation across all Monte-Carlo runs (we vary noise, not the field).
export function buildStrategies({ constants, grid, chosenCarId, weather, chosenStrategy, fieldSeed }) {
  const rng = makeRng(fieldSeed);
  const policies = makeRivalPolicies({ grid, chosenCarId, weather, constants, rng });
  const strategies = new Array(constants.num_cars);
  for (const carId of grid) {
    strategies[carId] = carId === chosenCarId ? chosenStrategy : policies[carId];
  }
  return strategies;
}

// Run a single full race (returns the whole per-lap array) for a given chosen-car strategy.
export function runRace({ constants, grid, chosenCarId, weather, chosenStrategy, fieldSeed = 1, seed = 1000, teamOf = null, carPace = null }) {
  const strategies = buildStrategies({ constants, grid, chosenCarId, weather, chosenStrategy, fieldSeed });
  return simulateRace({ constants, weather, strategies, grid, seed, teamOf, carPace });
}

// Scan N noise seeds and return the run in which the chosen car finishes best (its "best-case"
// race), for replay. Ties broken by smallest gap to the leader. Also returns that run's seed and
// the chosen car's finishing position, so the UI can label the replay honestly.
export function findBestCaseRun({
  constants, grid, chosenCarId, weather, chosenStrategy, fieldSeed = 1, N = 500, baseSeed = 1000, teamOf = null, carPace = null,
}) {
  let best = null;
  for (let i = 0; i < N; i++) {
    const seed = baseSeed + i * 7919;
    const race = runRace({ constants, grid, chosenCarId, weather, chosenStrategy, fieldSeed, seed, teamOf, carPace });
    const me = race.finish.find((f) => f.carId === chosenCarId);
    const leaderTime = race.finish[0].cumTime;
    const key = me.pos * 1e6 + (me.cumTime - leaderTime); // best = lowest position, then smallest gap
    if (best === null || key < best.key) best = { race, seed, finishPos: me.pos, key };
  }
  if (best) best.N = N; // how many runs we scanned, for honest "luckiest of N" labelling
  return best;
}

// Monte-Carlo evaluation of one chosen-car strategy.
// Returns expected positions gained, win probability, and the finishing-position histogram.
export function evaluateStrategy({
  constants, grid, chosenCarId, weather, chosenStrategy,
  fieldSeed = 1, N = 40, baseSeed = 1000, teamOf = null, carPace = null,
}) {
  const strategies = buildStrategies({ constants, grid, chosenCarId, weather, chosenStrategy, fieldSeed });
  const startPos = grid.indexOf(chosenCarId); // 0-based grid slot of the chosen car

  let sumGain = 0;
  let wins = 0;
  const finishCounts = new Array(constants.num_cars).fill(0);

  for (let i = 0; i < N; i++) {
    // Distinct, well-spread noise seed per run; field held fixed.
    const res = simulateRace({ constants, weather, strategies, grid, seed: baseSeed + i * 7919, teamOf, carPace });
    const me = res.finish.find((f) => f.carId === chosenCarId);
    const gained = me.startPos - me.pos;      // positions gained (start minus finish)
    sumGain += gained;
    if (me.pos === 0) wins++;                 // P1 finish
    finishCounts[me.pos]++;
  }

  return {
    startPos,
    N,
    expected_positions_gained: sumGain / N,
    p_win: wins / N,
    finishCounts,
  };
}

// ---------------------------------------------------------------------------
// Genetic algorithm (spec section 7).
//
// Fitness is ONE continuous value = expected_positions_gained + WIN_BONUS * p_win.
// This is the smooth "positions plus a win bonus" the spec asks for: not a hard
// "P1 else positions" switch, so the GA still climbs toward strategies that win
// more often even before any of them reaches a certain P1. WIN_BONUS is large
// relative to the ~±20 position swing so winning dominates, but it stays smooth
// because it scales with the *fraction* of runs won.
// ---------------------------------------------------------------------------
const WIN_BONUS = 30;

function randInt(rng, n) { return Math.floor(rng() * n); }
function choice(rng, arr) { return arr[randInt(rng, arr.length)]; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Legalise a list of stop laps: clamp into the race, sort, force a minimum gap between
// stops (and away from the very start/end), and dedupe.
function repairStops(laps, total) {
  const MIN_LAP = 4, MAX_LAP = total - 3, MIN_GAP = 5;
  const out = [];
  const sorted = laps.map((l) => clamp(Math.round(l), MIN_LAP, MAX_LAP)).sort((a, b) => a - b);
  for (const l of sorted) {
    if (out.length === 0 || l - out[out.length - 1] >= MIN_GAP) out.push(l);
    else out.push(out[out.length - 1] + MIN_GAP); // push later if too close
  }
  // Re-clamp any pushed-past-end laps and dedupe again.
  return out.map((l) => clamp(l, MIN_LAP, MAX_LAP)).filter((l, i, a) => i === 0 || l > a[i - 1]);
}

// Legalise the compound list for a given number of stints and weather. In DRY, F1 requires
// at least two different compounds in a race, so we enforce that; in DAMP/WET only one
// compound is legal, so every stint uses it.
function repairCompounds(compounds, nStints, legal, weather) {
  const out = [];
  for (let i = 0; i < nStints; i++) {
    // Fall back to the first legal compound (deterministic) if the gene is missing/illegal.
    out.push(legal.includes(compounds[i]) ? compounds[i] : legal[0]);
  }
  if (weather === 'DRY' && new Set(out).size < 2 && legal.length >= 2) {
    // Force a second distinct compound on the last stint.
    const other = legal.find((c) => c !== out[0]);
    out[out.length - 1] = other;
  }
  return out;
}

// Build per-compound tyre-set caps (2026 standard 2H/3M/8S) and per-compound cliff stint length,
// both from constants.compounds / constants.tyre_allocation (undefined -> effectively unlimited,
// so old constants files / Node test harnesses without these fields keep working unchanged).
function tyreLimits(constants, legal) {
  const maxStint = {}, setCap = {};
  for (const label of legal) {
    maxStint[label] = constants.compounds[label]?.max_stint_laps ?? Infinity;
    setCap[label] = constants.tyre_allocation?.[label] ?? Infinity;
  }
  return { maxStint, setCap };
}

// Enforce (a) no stint outlasts its compound's cliff length and (b) no compound is used in more
// stints than the race-weekend set allocation. Both fixed by swapping the OFFENDING stint to the
// hardest legal compound that both survives the stint length and still has spare set allocation, // this is what stops the GA proposing e.g. three separate long soft stints (only 8 soft sets exist,
// and a long stint on soft would outlast its ~18-32 lap cliff anyway).
function enforceTyreLimits(stops, compounds, total, legal, limits) {
  const { maxStint, setCap } = limits;
  const lens = compounds.map((_, i) => {
    const start = i === 0 ? 0 : stops[i - 1];
    const end = i === compounds.length - 1 ? total : stops[i];
    return end - start;
  });
  const out = compounds.slice();
  const used = Object.fromEntries(legal.map((l) => [l, 0]));
  const byHardness = [...legal].sort((a, b) => (maxStint[b] ?? 0) - (maxStint[a] ?? 0));

  for (let i = 0; i < out.length; i++) {
    const len = lens[i];
    const fits = (label) => len <= (maxStint[label] ?? Infinity) && used[label] < (setCap[label] ?? Infinity);
    if (!fits(out[i])) {
      const alt = byHardness.find(fits) ?? byHardness.find((label) => len <= (maxStint[label] ?? Infinity)) ?? byHardness[0];
      out[i] = alt;
    }
    used[out[i]] = (used[out[i]] ?? 0) + 1;
  }
  return out;
}

// Make a genome valid: consistent lengths, legal laps and compounds.
function repair(genome, legal, total, weather, constants = null) {
  let stops = repairStops(genome.stops, total);
  if (stops.length < 1) stops = repairStops([Math.round(total / 2)], total);
  if (stops.length > 3) stops = stops.slice(0, 3);
  let compounds = repairCompounds(genome.compounds, stops.length + 1, legal, weather);
  if (constants) {
    compounds = enforceTyreLimits(stops, compounds, total, legal, tyreLimits(constants, legal));
    // Tyre-limit swaps can collapse DRY back to one compound (e.g. a single long stint forced
    // onto the only compound that survives it), re-apply the >=2-compound rule where possible.
    if (weather === 'DRY' && new Set(compounds).size < 2 && legal.length >= 2) {
      const other = legal.find((c) => c !== compounds[0]);
      if (other) compounds[compounds.length - 1] = other;
    }
  }
  return { stops, compounds };
}

function randomStops(rng, n, total) {
  const laps = [];
  for (let i = 1; i <= n; i++) {
    const frac = i / (n + 1);
    laps.push(total * frac + (rng() * 2 - 1) * 4);
  }
  return laps;
}

function randomGenome(rng, legal, total, weather, constants = null) {
  const nStops = 1 + randInt(rng, 3); // 1..3
  const stops = randomStops(rng, nStops, total);
  const compounds = [];
  for (let i = 0; i < nStops + 1; i++) compounds.push(choice(rng, legal));
  return repair({ stops, compounds }, legal, total, weather, constants);
}

// Uniform crossover on the stop laps and compounds, taking the stop count from one parent.
function crossover(a, b, rng, legal, total, weather, constants = null) {
  const base = rng() < 0.5 ? a : b;
  const nStops = base.stops.length;
  const stops = base.stops.map((lap, i) => {
    const alt = (rng() < 0.5 ? a : b).stops[i];
    return alt !== undefined ? alt : lap;
  });
  const compounds = [];
  for (let i = 0; i < nStops + 1; i++) {
    const ca = a.compounds[i], cb = b.compounds[i];
    compounds.push(rng() < 0.5 ? (ca ?? cb) : (cb ?? ca));
  }
  return repair({ stops, compounds }, legal, total, weather, constants);
}

// Mutation: nudge stop laps, swap a compound within the legal set, and occasionally
// add or drop a stop (changing the stop count).
function mutate(genome, rng, legal, total, weather, constants = null) {
  let stops = genome.stops.slice();
  let compounds = genome.compounds.slice();

  if (stops.length && rng() < 0.6) {
    const i = randInt(rng, stops.length);
    stops[i] += randInt(rng, 9) - 4; // ±4 laps
  }
  if (rng() < 0.5) {
    const i = randInt(rng, compounds.length);
    compounds[i] = choice(rng, legal);
  }
  if (rng() < 0.2) {
    if (stops.length < 3 && rng() < 0.5) {
      stops.push(total * (0.4 + rng() * 0.3));        // add a stop
      compounds.push(choice(rng, legal));
    } else if (stops.length > 1) {
      const i = randInt(rng, stops.length);            // drop a stop
      stops.splice(i, 1);
      compounds.splice(i + 1, 1);
    }
  }
  return repair({ stops, compounds }, legal, total, weather, constants);
}

function tournament(scored, rng, k) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const cand = scored[randInt(rng, scored.length)];
    if (best === null || cand.fit > best.fit) best = cand;
  }
  return best;
}

// Evolve the chosen car's strategy. Returns the recommended strategy plus its reported metrics.
export function evolveStrategy(config) {
  const {
    constants, grid, chosenCarId, weather, teamOf = null, carPace = null,
    popSize = 24, generations = 12, tournamentK = 3, elitism = 2,
    N = 24, finalN = 500, mutationRate = 0.9,
    fieldSeed = 1, baseSeed = 1000, seed = 12345,
    onProgress = null,
  } = config;

  const rng = makeRng(seed);
  const legal = constants.weather[weather].allowed;
  const total = constants.total_laps;

  const evalGenome = (g, n) => evaluateStrategy({
    constants, grid, chosenCarId, weather, chosenStrategy: g, fieldSeed, N: n, baseSeed, teamOf, carPace,
  });
  const fitnessOf = (ev) => ev.expected_positions_gained + WIN_BONUS * ev.p_win;
  const score = (g) => { const ev = evalGenome(g, N); return { g, ev, fit: fitnessOf(ev) }; };

  let scored = [];
  for (let i = 0; i < popSize; i++) scored.push(score(randomGenome(rng, legal, total, weather, constants)));

  const history = [];
  let best = scored.reduce((m, s) => (s.fit > m.fit ? s : m), scored[0]);

  for (let gen = 0; gen < generations; gen++) {
    scored.sort((a, b) => b.fit - a.fit);
    if (scored[0].fit > best.fit) best = scored[0];
    history.push({ gen, bestFit: best.fit, bestPWin: best.ev.p_win, bestGained: best.ev.expected_positions_gained });
    if (onProgress) onProgress({ gen, generations, best });

    const next = scored.slice(0, elitism).map((s) => s.g); // elitism
    while (next.length < popSize) {
      const p1 = tournament(scored, rng, tournamentK).g;
      const p2 = tournament(scored, rng, tournamentK).g;
      let child = crossover(p1, p2, rng, legal, total, weather, constants);
      if (rng() < mutationRate) child = mutate(child, rng, legal, total, weather, constants);
      next.push(child);
    }
    scored = next.map(score);
  }

  scored.sort((a, b) => b.fit - a.fit);
  if (scored[0].fit > best.fit) best = scored[0];

  // Re-evaluate the winner at higher N for a stable final report.
  const finalEv = evalGenome(best.g, finalN);

  return {
    strategy: best.g,                                        // recommended strategy (modal winner)
    p_win: finalEv.p_win,
    expected_positions_gained: finalEv.expected_positions_gained,
    finishCounts: finalEv.finishCounts,
    startPos: finalEv.startPos,
    fitness: fitnessOf(finalEv),
    history,
  };
}
