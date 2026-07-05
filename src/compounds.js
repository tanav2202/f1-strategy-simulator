// compounds.js, resolve a track's REAL Pirelli compound allocation (hard/medium/soft -> C1..C5)
// into track-accurate pace/deg, shared by every consumer: the calibrate/ Node pipeline
// (recommend.mjs/review.mjs/backtest scripts), the live Silverstone browser app (main.js/ui.js),
// and the race-day predictions page (predictions.js). One implementation so all three always
// agree on what a "soft" means at a given track.
//
// raceMeta: the shape data/races.json entries already have, { compounds: {hard,medium,soft},
// tyre_severity }. Mutates constants.compounds[label] in place (pace_offset/deg_per_lap/
// max_stint_laps) and returns the label<->C-number map + severity for display, or null if the
// track has no allocation (falls back to the hand-tuned flattened defaults already in constants).
export function resolveCompounds(raceMeta, constants) {
  const alloc = raceMeta?.compounds;
  const model = constants.compound_model;
  if (!alloc || !model) return null;
  const severity = raceMeta.tyre_severity ?? 1.0;
  const hints = raceMeta.stint_length_hints || {};
  const medBase = model[alloc.medium].pace_offset; // re-centre so medium = 0
  for (const label of ['hard', 'medium', 'soft']) {
    const c = alloc[label];
    const m = model[c];
    if (!m) continue;
    // Sourced per-track stint-length figures (races.json stint_length_hints, from official
    // Pirelli previews) are used as a TIGHTENING-ONLY sanity check on max_stint_laps, never a
    // loosening one. Tried using them directly as the ceiling first; that regressed stop-count
    // accuracy (78/134 to 65/134), because Pirelli's figures describe how long a compound CAN
    // physically survive, not how long a smart team actually runs it, and hard/medium can often
    // survive well past the point where the cost-optimal thing to do is pit. Handing the DP a
    // longer technically-legal ceiling let it exploit stints that are legal but not realistic,
    // exposing that our deg_per_lap likely understates true late-stint cost, a deeper fix than a
    // ceiling number, so for now the sourced figures only clamp the generic estimate DOWN if
    // they're stricter, never stretch it out.
    const generic = Math.max(6, Math.round(m.max_stint_laps / severity));
    const maxStint = hints[label] != null ? Math.min(generic, hints[label]) : generic;
    constants.compounds[label] = {
      ...constants.compounds[label],
      pace_offset: +(m.pace_offset - medBase).toFixed(3),
      deg_per_lap: +(m.deg_per_lap * severity).toFixed(4),
      max_stint_laps: maxStint,
      compound: c,
    };
  }
  return {
    byLabel: { hard: alloc.hard, medium: alloc.medium, soft: alloc.soft },
    byCompound: { [alloc.hard]: 'hard', [alloc.medium]: 'medium', [alloc.soft]: 'soft' },
    severity,
    source: raceMeta.compounds_source || null,
    stintLengthSource: raceMeta.stint_length_source || null,
  };
}
