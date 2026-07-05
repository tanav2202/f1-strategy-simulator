// render-map.js, top-down map view (spec section 8).
//
// Draws the Silverstone outline and one dot per car, coloured by current tyre compound, placed
// around the loop by track position and progress within the lap. The chosen car is highlighted.
// Driven by the same fractional playhead as the trace.
//
// Placement note (non-obvious): the engine only stores integer-lap snapshots, so to place cars
// around the loop we take the *leader's* progress within the current lap (the fractional part of
// the playhead) and set each car behind it by its time-gap-to-leader converted into a fraction of
// a lap (gap / base_lap_seconds). Gaps are interpolated between the two bracketing lap snapshots so
// motion is smooth. When two cars' gaps cross between laps, their dots swap, that is an overtake.

const MARGIN = 26;

// Tracks are now traced from DENSE real FastF1 GPS telemetry (~400 points), so the true corner
// geometry is already there in the data, no synthetic curve-fitting. We deliberately do NOT
// Catmull-Rom smooth these any more: smoothing a sparse hand-traced outline used to make corners
// read as flowing curves, but on real telemetry it rounds off genuine hairpins/chicanes into
// arcs that don't match the official circuit shape. Plain straight segments between 400 close
// real points already render as an accurate, correctly-cornered track.

// Precompute a closed polyline with cumulative arc length so we can find a point at any fraction.
function buildPath(rawPoints, W, H) {
  const points = rawPoints;
  // Fit normalised [0,1] points into the canvas, preserving aspect ratio and centring.
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const scale = Math.min((W - 2 * MARGIN) / spanX, (H - 2 * MARGIN) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const pts = points.map(([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale]);

  // Cumulative length around the closed loop.
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

// Point at fraction f in [0,1) around the loop.
function pointAt(path, f) {
  const target = ((f % 1) + 1) % 1 * path.total;
  const { pts, cum } = path;
  let i = 1;
  while (i < cum.length && cum[i] < target) i++;
  const segStart = cum[i - 1];
  const segLen = cum[i] - segStart || 1;
  const t = (target - segStart) / segLen;
  const a = pts[(i - 1) % pts.length];
  const b = pts[i % pts.length];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Pick black or white text for legibility on a given fill colour (teal/silver/orange teams need
// dark text, dark-blue/red/green need white).
function contrastText(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#15151e' : '#ffffff';
}

export function renderMap(ctx, opts) {
  const { race, track, drivers, chosenCarId, lap, constants } = opts;
  // Logical (CSS-pixel) size; caller scales the backing store by devicePixelRatio.
  const W = opts.W ?? ctx.canvas.width;
  const H = opts.H ?? ctx.canvas.height;
  const totalLaps = constants.total_laps;
  const numCars = drivers.length;

  ctx.clearRect(0, 0, W, H);
  const path = buildPath(track.points, W, H);

  // --- track ribbon ---
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  path.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // start/finish line
  const sf = pointAt(path, 0);
  ctx.fillStyle = '#e10600';
  ctx.fillRect(sf[0] - 2, sf[1] - 8, 4, 16);

  // --- car placement ---
  const lapInt = Math.min(Math.floor(lap), totalLaps);
  const frac = Math.min(lap, totalLaps) - lapInt;
  const next = Math.min(lapInt + 1, totalLaps);
  const cumNow = new Array(numCars);
  for (let c = 0; c < numCars; c++) {
    const a = race.laps[lapInt][c].cumTime;
    const b = race.laps[next][c].cumTime;
    cumNow[c] = a + (b - a) * frac;
  }
  const leaderCum = Math.min(...cumNow);
  const baseLap = constants.base_lap_seconds;
  const compoundColor = (c) => (constants.compounds[c] ? constants.compounds[c].color : '#888');

  const R = 9, RC = 12;

  // Place cars around the loop in running order, spaced by their real gap to the leader but with a
  // MINIMUM separation so dots never pile up. At lights-out every gap is ~0, which would otherwise
  // crush all 22 into one clump; min-separation instead lays them out as a clean, evenly-spaced
  // grid queue back from the start/finish line. During the race, exact running order is always
  // preserved and big gaps still show roughly to scale.
  // (Note: a real F1 grid stagger is only ~8 m per slot, a true-to-scale grid would be an
  //  unreadable dot-pile, so the map deliberately spreads the field for legibility.)
  const order = [...Array(numCars).keys()].sort((a, b) => cumNow[a] - cumNow[b]);
  const minSep = (2.6 * RC) / path.total; // minimum spacing between consecutive dots, in lap-fraction
  const dots = [];
  let placed = 0;
  order.forEach((c, i) => {
    const want = (cumNow[c] - leaderCum) / baseLap;         // to-scale offset behind the leader
    placed = i === 0 ? 0 : Math.max(want, placed + minSep); // but never closer than minSep
    const [x, y] = pointAt(path, frac - placed);
    const snap = race.laps[lapInt][c];
    dots.push({ c, x, y, compound: snap.compound, pos: snap.pos });
  });

  // Dot FILL = team colour (identity), RING = tyre compound (strategy), and the running position
  // number sits INSIDE the dot, so there are no external text labels to overlap (that was the
  // clutter). Only the chosen car gets an outside code pill, plus a red halo.
  const drawDot = (d, chosen) => {
    const r = chosen ? RC : R;
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.fillStyle = drivers[d.c].color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = compoundColor(d.compound);
    ctx.stroke();
    if (chosen) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#e10600';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = contrastText(drivers[d.c].color);
    ctx.font = `700 ${chosen ? 11 : 9}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(d.pos + 1), d.x, d.y + 0.5);
  };
  for (const d of dots) if (d.c !== chosenCarId) drawDot(d, false);
  const chosenDot = dots.find((d) => d.c === chosenCarId);
  if (chosenDot) drawDot(chosenDot, true);

  // chosen car's code pill, on top of everything
  if (chosenDot) {
    const label = drivers[chosenDot.c].code;
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const w = ctx.measureText(label).width + 10;
    const lx = chosenDot.x - w / 2, ly = chosenDot.y - RC - 19;
    ctx.fillStyle = '#e10600';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(lx, ly, w, 16, 4); else ctx.rect(lx, ly, w, 16);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, chosenDot.x, ly + 8);
  }

  // lap counter
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Lap ${Math.min(Math.ceil(lap), totalLaps)}/${totalLaps}`, 10, 10);
}
