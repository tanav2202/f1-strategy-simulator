// engine.js, race engine (spec section 5).
//
// One deterministic 52-lap simulation for N cars. Given a fixed seed the result is fully
// reproducible (no Math.random anywhere, everything draws from the seeded PRNG below).
//
// simulateRace() returns a per-lap array `laps[lap][car]` of records
// { cumTime, pos, compound, age, lapTime }, plus a `finish` summary ordered P1..PN.
// Both visualisations and the GA are built on top of this array (spec section 3).

// ---------------------------------------------------------------------------
// Seeded PRNG. Mulberry32: tiny, fast, good enough for Monte-Carlo noise, and
// deterministic so a given seed always reproduces the same race.
// ---------------------------------------------------------------------------
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal via Box–Muller, driven by the seeded uniform generator.
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// A strategy is { stops: [lap...], compounds: [c0, c1...] } where compounds
// has one more entry than stops (the compound for each stint). Fixed plans are
// executed by counting completed stops (so an SC can shift a stop earlier and
// the rest of the plan still follows in sequence).
// ---------------------------------------------------------------------------
// simulateRace
//
// config:
//   constants   parsed data/constants.json
//   weather     "DRY" | "DAMP" | "WET"
//   strategies  array length numCars, each { stops:[...], compounds:[...] }
//   grid        array length numCars of carIds in P1..PN order at the start
//   seed        integer; same seed => identical race
//   numCars     defaults to constants.num_cars
//
// Returns { laps, finish, grid, weather } where
//   laps[lap]      (lap 0..totalLaps) array indexed by carId of per-lap state
//   finish         array of { carId, pos, cumTime, startPos } ordered P1..PN
// ---------------------------------------------------------------------------
export function simulateRace(config) {
  const { constants, weather, strategies, grid, seed } = config;
  const teamOf = config.teamOf ?? null;   // carId -> team id; enables the double-stack rule
  // Optional per-car pace (v2): carPace[carId] = seconds added to every lap for that car
  // (0 = the flattened-pace v1 default). Real per-car pace is derived from FastF1 (see src/pace.js).
  const carPace = config.carPace ?? null;
  const numCars = config.numCars ?? constants.num_cars;
  const totalLaps = constants.total_laps;
  const rng = makeRng(seed);

  const weatherCfg = constants.weather[weather];
  const weatherOffset = weatherCfg.offset_seconds;
  const ot = constants.overtake;
  const sc = constants.safety_car ?? null;   // safety-car model (spec section 5); null disables it

  // Per-car mutable state.
  const cumTime = new Array(numCars).fill(0);
  const tyreAge = new Array(numCars).fill(0);
  const compound = new Array(numCars);
  const startPos = new Array(numCars);   // grid position (0-based) per carId
  const executedStops = new Array(numCars).fill(0);           // reactive: stops completed so far
  const executedPits = Array.from({ length: numCars }, () => []); // actual pit laps per car (for the trace)

  // Track-order bookkeeping used by the undercut-cover rule (who is directly behind whom, and
  // who pitted last lap). Updated each lap in recordLap / the pit phase.
  let lastOrder = null;      // carIds ordered by cumulative time at the previous snapshot
  let lastPosOf = null;      // carId -> track position at the previous snapshot
  let pittedLastLap = new Set();

  // Per-RUN reactive state (must live here, not on the policy objects, because policies are
  // shared across all Monte-Carlo runs of an evaluation): overcut extensions to planned stops.
  const extraTarget = new Array(numCars).fill(0);   // laps added to the next planned stop (overcut)
  const extendedOnce = new Array(numCars).fill(false);

  // Safety-car state: at most one deployment per race, drawn from the run's noise rng, so
  // whether/when an SC appears varies across Monte-Carlo runs (spec section 5).
  let scLapsLeft = 0;
  let scDeployed = false;
  const scLaps = [];

  // Initialise from the grid. Small staggered start offset (grid slot * gap) so P1
  // genuinely leads at lap 0 before any racing happens; keeps early ordering stable.
  const START_GAP = 0.3;
  grid.forEach((carId, gridPos) => {
    startPos[carId] = gridPos;
    cumTime[carId] = gridPos * START_GAP;
    compound[carId] = strategies[carId].compounds[0];
  });

  // laps[0] is the pre-race state (lap 0 = grid). laps[l] is state after completing lap l.
  const laps = [];
  const recordLap = (lapNo, scActive = false) => {
    // Order cars by cumulative time to get track position.
    const order = [...Array(numCars).keys()].sort((a, b) => cumTime[a] - cumTime[b]);
    const posOf = new Array(numCars);
    order.forEach((carId, i) => { posOf[carId] = i; });
    const snapshot = new Array(numCars);
    for (let c = 0; c < numCars; c++) {
      snapshot[c] = {
        cumTime: cumTime[c],
        pos: posOf[c],
        compound: compound[c],
        age: tyreAge[c],
        sc: scActive,
      };
    }
    laps[lapNo] = snapshot;
    lastOrder = order;
    lastPosOf = posOf;
    return { order, posOf };
  };

  recordLap(0);

  // Rolling pace estimate per car, updated each lap, used by the overtaking model to
  // judge "who is genuinely faster right now" independent of one lap's noise spike.
  const rollingPace = new Array(numCars).fill(constants.base_lap_seconds);

  for (let lap = 1; lap <= totalLaps; lap++) {
    const lapsRemaining = totalLaps - lap;

    // 0) Safety car: possibly deploy (one per race, never in the closing laps), or count down.
    //    Drawn from the per-run noise rng so Monte-Carlo runs differ in whether/when it appears.
    if (sc && scLapsLeft === 0 && !scDeployed && lapsRemaining >= sc.last_deploy_laps_left) {
      if (rng() < sc.prob_per_lap) {
        scDeployed = true;
        scLapsLeft = sc.min_laps + Math.floor(rng() * (sc.max_laps - sc.min_laps + 1));
      }
    }
    const scActive = scLapsLeft > 0;
    if (scActive) scLaps.push(lap);

    // 1) Apply pit stops at the START of this lap: add pit loss, reset age, switch compound.
    //    (Done before the lap so the fresh tyre + pit loss both land on this lap.)
    //    Fixed cars (chosen car / GA genome) pit on their scheduled laps and take priority;
    //    reactive cars (rivals) decide from their field policy (spec section 6). Team rule: a team
    //    may not pit BOTH cars on the same lap, so a reactive car whose team-mate already pitted
    //    this lap defers to a later lap (enforced only when `teamOf` is supplied).
    //    Under SC the stop is cheap (field laps slowly, so less relative time is lost).
    // pit_realism_seconds (optional, default 0): cold-tyre out-lap tax + rejoin/traffic risk, on
    // top of the pure pit-lane time-loss. Real F1 out-laps are measurably slower until tyres reach
    // temperature; without this, an exact optimiser (src/dp.js) will always prefer splitting a
    // stint in two (deg-time is convex in stint length) purely because the clock says it's free.
    const pitLoss = (constants.pit_loss_seconds + (constants.pit_realism_seconds || 0))
      * (scActive && sc ? sc.pit_loss_multiplier : 1);
    const pittedThisLap = new Set();
    const teamPittedThisLap = new Set();
    const commitPit = (c, newCompound) => {
      cumTime[c] += pitLoss;
      tyreAge[c] = 0;
      compound[c] = newCompound;
      executedStops[c] += 1;
      executedPits[c].push(lap);
      pittedThisLap.add(c);
      if (teamOf) teamPittedThisLap.add(teamOf[c]);
    };

    // 1a) Fixed-schedule cars first (they win a same-lap team tie). A fixed plan pits on its
    //     scheduled laps, except under SC, where any real strategist shifts an upcoming stop
    //     onto the SC lap to take it cheaply (spec section 5).
    for (let c = 0; c < numCars; c++) {
      const plan = strategies[c];
      if (plan.reactive) continue;
      const done = executedStops[c];
      const nextStop = plan.stops ? plan.stops[done] : undefined;
      if (nextStop === undefined) continue;
      const due = lap >= nextStop;
      const scShift = scActive && sc && nextStop > lap && nextStop - lap <= sc.fixed_shift_window;
      if (due || scShift) commitPit(c, plan.compounds[done + 1] ?? compound[c]);
    }

    // 1b) Reactive cars, in track order (leader first) so the car ahead wins a team tie.
    const reactiveOrder = (lastOrder ?? [...Array(numCars).keys()]).filter((c) => strategies[c].reactive);
    for (const c of reactiveOrder) {
      const plan = strategies[c];
      const done = executedStops[c];
      if (done >= plan.targetStops.length || lap > plan.latestStop) continue;
      // Team double-stack rule: defer if a team-mate already pitted this lap.
      if (teamOf && teamPittedThisLap.has(teamOf[c])) continue;

      const target = plan.targetStops[done] + extraTarget[c]; // overcut extension shifts the plan
      const degLoss = constants.compounds[compound[c]].deg_per_lap * tyreAge[c];
      const ahead = lastPosOf && lastPosOf[c] > 0 ? lastOrder[lastPosOf[c] - 1] : undefined;
      const behind = lastPosOf ? lastOrder[lastPosOf[c] + 1] : undefined;

      let trigger = false;
      if (scActive && sc && tyreAge[c] >= sc.rival_pit_min_age) {
        trigger = true;                        // safety car: take the cheap stop
      } else if (lap >= target) {
        trigger = true;                        // reached the planned stop lap (primary trigger)
      } else if (degLoss >= plan.degThreshold) {
        trigger = true;                        // tyres fell off early (safety trigger)
      } else if (plan.undercut && plan.undercut.enabled && ahead !== undefined
                 && !pittedThisLap.has(ahead) && !pittedLastLap.has(ahead)
                 && (cumTime[c] - cumTime[ahead]) <= plan.undercut.gapWindow
                 && tyreAge[c] >= plan.undercut.minAge
                 && (target - lap) <= plan.undercut.earlyLaps) {
        trigger = true;                        // offensive undercut: stuck behind, stop near anyway
      } else if (plan.cover.enabled && tyreAge[c] >= plan.cover.minAge
                 && (target - lap) <= plan.cover.earlyLaps
                 && behind !== undefined && pittedLastLap.has(behind)) {
        // The car directly behind pitted into clear air. Per-car pit-wall style:
        // cover (pit now to defend) or overcut (extend a few laps in clear air, once).
        if (plan.coverStyle === 'extend' && !extendedOnce[c]) {
          extendedOnce[c] = true;
          extraTarget[c] += plan.extendLaps ?? 3;
        } else {
          trigger = true;
        }
      }
      if (trigger) commitPit(c, plan.compounds[done + 1] ?? compound[c]);
    }
    pittedLastLap = pittedThisLap;

    // 2) Compute this lap's lap time for each car. Under SC everyone trundles behind the safety
    //    car at the same slow pace (gaps freeze), tyres age at half rate, and per-car pace /
    //    compound / fuel differences don't express themselves.
    const lapTime = new Array(numCars);
    if (scActive && sc) {
      for (let c = 0; c < numCars; c++) {
        lapTime[c] = (constants.base_lap_seconds + weatherOffset) * sc.pace_multiplier
          + gaussian(rng) * 0.05;
      }
    } else {
      for (let c = 0; c < numCars; c++) {
        const comp = constants.compounds[compound[c]];
        lapTime[c] = constants.base_lap_seconds
          + (carPace ? carPace[c] || 0 : 0)   // per-car pace (v2); 0 under flattened v1
          + weatherOffset
          + comp.pace_offset
          + comp.deg_per_lap * tyreAge[c]
          + constants.fuel_coeff_seconds_per_lap * lapsRemaining
          + gaussian(rng) * constants.lap_noise_sigma_seconds;
      }
    }

    // 3) Update rolling pace (exponential moving average) from the clean lap times.
    //    Skipped under SC: a 127s SC lap says nothing about who is fast.
    if (!scActive) {
      for (let c = 0; c < numCars; c++) {
        rollingPace[c] = 0.6 * rollingPace[c] + 0.4 * lapTime[c];
      }
    }

    // 4) Overtaking + dirty air, evaluated in current track order (leader first). No passing
    //    under SC. A follower may attempt a pass on the car directly ahead only if its rolling
    //    pace is genuinely faster (threshold), and the pass probability SATURATES with the pace
    //    advantage: p = cap * (1 - exp(-k * (advantage - threshold))). A few tenths stays stuck
    //    in dirty air; a second or more per lap (fresh tyres vs dead ones, front-runner vs
    //    backmarker) passes within a lap or two. A failed pass costs the dirty-air penalty.
    if (!scActive) {
      const orderBefore = [...Array(numCars).keys()].sort((a, b) => cumTime[a] - cumTime[b]);
      for (let i = 1; i < orderBefore.length; i++) {
        const follower = orderBefore[i];
        const leader = orderBefore[i - 1];
        const gapAhead = cumTime[follower] - cumTime[leader]; // positive; follower is behind
        if (gapAhead > ot.dirty_air_window) continue;

        // Positive advantage = follower's rolling pace is lower (faster) than leader's.
        const paceAdvantage = rollingPace[leader] - rollingPace[follower];
        if (paceAdvantage > ot.pace_gap_threshold) {
          const prob = ot.prob_cap
            * (1 - Math.exp(-ot.pass_k * (paceAdvantage - ot.pace_gap_threshold)));
          if (rng() < prob) {
            // Pass succeeds: nudge the follower just ahead of the leader on cumulative time.
            cumTime[follower] = cumTime[leader] - 0.01;
            continue;
          }
        }
        // No pass (ineligible or failed): follower takes the dirty-air penalty this lap
        // (models tyre overheating in traffic).
        lapTime[follower] += ot.dirty_air_penalty;
      }
    }

    // 5) Commit lap times to cumulative time and age the tyres (half rate under SC).
    for (let c = 0; c < numCars; c++) {
      cumTime[c] += lapTime[c];
      tyreAge[c] += scActive ? 0.5 : 1;
    }

    // 6) SC restart: on the last SC lap, bunch the field, order preserved, gaps compressed.
    //    Track position earned before the SC is kept; time gaps are erased.
    if (scActive) {
      scLapsLeft -= 1;
      if (scLapsLeft === 0 && sc) {
        const order = [...Array(numCars).keys()].sort((a, b) => cumTime[a] - cumTime[b]);
        const leaderTime = cumTime[order[0]];
        order.forEach((c, i) => { cumTime[c] = leaderTime + i * sc.bunch_gap_s; });
      }
    }

    recordLap(lap, scActive);
  }

  // Final classification.
  const finalOrder = [...Array(numCars).keys()].sort((a, b) => cumTime[a] - cumTime[b]);
  const finish = finalOrder.map((carId, i) => ({
    carId,
    pos: i,                    // 0-based finishing position
    cumTime: cumTime[carId],
    startPos: startPos[carId], // 0-based grid position
  }));

  return { laps, finish, grid, weather, executedPits, scLaps };
}
