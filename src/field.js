// field.js, rival field heuristics (spec section 6).
//
// The 21 non-chosen cars run REACTIVE, rule-based strategies (not evolved). This module only
// produces each rival's *policy* (the heuristic parameters); the engine executes the actual
// pit decisions lap-by-lap against that policy. Separation: "what a sensible team plans" lives
// here; "when the stop actually happens in the race" lives in engine.js.
//
// A policy is:
//   {
//     reactive: true,
//     compounds:   [c0, c1...],   // compound per stint, length = planned stops + 1 (weather-legal)
//     targetStops: [lap...],      // planned stop laps (the point a sensible team expects deg to
//                                   //   warrant a stop). Primary trigger. Sorted, within the race.
//     degThreshold: seconds,        // safety trigger: pit early if deg time-loss exceeds this
//                                   //   (mainly bites on soft stints that fall off a cliff).
//     cover: { enabled, window, minAge, earlyLaps },  // reacts when the car directly behind pits
//                                   //   into clear air (spec section 6)...
//     coverStyle: 'cover'|'extend', // ...either pit to defend (cover) or extend the stint a few
//     extendLaps: n,                //   laps in clear air (overcut), per-car pit-wall style.
//     undercut: { enabled, gapWindow, minAge, earlyLaps },  // offensive undercut: stuck within
//                                   //   gapWindow seconds behind, stop near anyway -> pit early.
//     latestStop: lap,              // never pit after this (avoids silly last-lap stops).
//   }
//
// The rival field must be sensible ("teams are not stupid") but must NOT be optimal, or the chosen
// car has no room to beat it (spec section 6). So plans are reasonable but deliberately un-tuned:
// a spread of 1- and 2-stoppers, jittered stop laps, no lookahead to the GA's plan.

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Build a policy for every car except the chosen one. `rng` is the seeded generator so the field
// is reproducible for a given seed but varies across seeds.
export function makeRivalPolicies({ grid, chosenCarId, weather, constants, rng }) {
  const legal = constants.weather[weather].allowed; // DRY: [soft, medium, hard] (softest first)
  const policies = {};
  for (const carId of grid) {
    if (carId === chosenCarId) continue;
    policies[carId] = makePolicy(weather, legal, constants, rng);
  }
  return policies;
}

function makePolicy(weather, legal, constants, rng) {
  const total = constants.total_laps;
  const jit = (amt) => (rng() * 2 - 1) * amt; // symmetric jitter in [-amt, +amt]

  // Per-car pit-wall personality (spec section 6): most walls are undercut-capable but not all
  // fire it; when the car behind pits, ~60% cover (pit to defend), the rest overcut (extend in
  // clear air). Both drawn per field-seed so the field is fixed across one evaluation's MC runs.
  const personality = () => ({
    coverStyle: rng() < 0.6 ? 'cover' : 'extend',
    extendLaps: 2 + Math.round(rng() * 2),                    // overcut extends 2-4 laps
    undercut: { enabled: rng() < 0.7, gapWindow: 2.0, minAge: 8, earlyLaps: 5 },
  });

  if (weather === 'DRY') {
    // Spread the field across 1- and 2-stop plans (~55% one-stop).
    const oneStop = rng() < 0.55;

    if (oneStop) {
      // Start on medium (mostly) or soft; always finish on a harder tyre so >= 2 compounds are
      // used (dry-race rule) and the plan is coherent (fast-early / durable-late).
      const start = rng() < 0.7 ? 'medium' : 'soft';
      const finish = start === 'soft' ? (rng() < 0.5 ? 'medium' : 'hard') : 'hard';
      // Planned stop around mid-distance with a few laps of per-car jitter.
      const target = clamp(Math.round(total * (0.50 + jit(0.06))), 18, 40);
      return {
        reactive: true,
        compounds: [start, finish],
        targetStops: [target],
        degThreshold: 2.0,                                   // generous: only pre-empts a dead soft
        cover: { enabled: true, window: 2.0, minAge: 8, earlyLaps: 6 },
        latestStop: total - 4,
      };
    }

    // Two-stop: pick a sensible sequence (>= 2 distinct compounds), stops near thirds of the race.
    const twoStopSeqs = [
      ['soft', 'medium', 'hard'],
      ['medium', 'hard', 'medium'],
      ['soft', 'medium', 'medium'],
      ['medium', 'soft', 'hard'],
    ];
    const compounds = twoStopSeqs[Math.floor(rng() * twoStopSeqs.length)];
    const t1 = clamp(Math.round(total * (0.33 + jit(0.05))), 12, 24);
    const t2 = clamp(Math.round(total * (0.66 + jit(0.05))), t1 + 8, 44);
    return {
      reactive: true,
      compounds,
      targetStops: [t1, t2],
      degThreshold: 1.6,
      cover: { enabled: true, window: 2.0, minAge: 6, earlyLaps: 6 },
      latestStop: total - 4,
    };
  }

  // DAMP / WET: only one legal compound, so stops are just for fresh rubber. Mostly one-stop.
  const comp = legal[0];
  const twoStop = rng() < 0.4;
  if (!twoStop) {
    const target = clamp(Math.round(total * (0.50 + jit(0.08))), 16, 40);
    return {
      reactive: true,
      compounds: [comp, comp],
      targetStops: [target],
      degThreshold: 2.5,
      cover: { enabled: false, window: 2.0, minAge: 8, earlyLaps: 6 },
      latestStop: total - 4,
    };
  }
  const t1 = clamp(Math.round(total * (0.34 + jit(0.05))), 12, 24);
  const t2 = clamp(Math.round(total * (0.66 + jit(0.05))), t1 + 8, 44);
  return {
    reactive: true,
    compounds: [comp, comp, comp],
    targetStops: [t1, t2],
    degThreshold: 2.0,
    cover: { enabled: false, window: 2.0, minAge: 6, earlyLaps: 6 },
    latestStop: total - 4,
  };
}
