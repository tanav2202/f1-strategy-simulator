// render-trace.js, race trace view (spec section 8).
//
// x-axis: lap (1..totalLaps). y-axis: track position (P1 at the top). One line per car,
// coloured by the tyre compound of each segment, with a marker at every pit lap. The chosen
// car is drawn last, brighter and thicker. A playhead marks the current lap. An undercut shows
// up as one line jumping above another right after a pit, the drama the GA optimises for.
//
// This is a pure function of the stored race + playhead: the same data drives the map too.

const PAD = { top: 18, right: 14, bottom: 30, left: 34 };

export function renderTrace(ctx, opts) {
  const { race, drivers, chosenCarId, lap, constants } = opts;
  // Logical (CSS-pixel) size, the caller scales the backing store by devicePixelRatio for
  // crispness, so we must draw in logical units, not the physical canvas.width/height.
  const W = opts.W ?? ctx.canvas.width;
  const H = opts.H ?? ctx.canvas.height;
  const numCars = drivers.length;
  const totalLaps = constants.total_laps;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xOf = (lapNo) => PAD.left + (lapNo / totalLaps) * plotW;
  const yOf = (pos0) => PAD.top + (pos0 / (numCars - 1)) * plotH; // pos0 = 0 (P1) at top

  ctx.clearRect(0, 0, W, H);

  // --- gridlines + axis labels ---
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  for (let l = 0; l <= totalLaps; l += 10) {
    const x = xOf(l);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + plotH); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(String(l), x, H - PAD.bottom + 12);
  }
  ctx.textAlign = 'right';
  for (const p of [1, 5, 10, 15, 20, numCars]) {
    const y = yOf(p - 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + plotW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('P' + p, PAD.left - 5, y);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('lap', PAD.left + plotW / 2, H - 6);

  const upto = Math.min(Math.floor(lap), totalLaps);
  const compoundColor = (c) => (constants.compounds[c] ? constants.compounds[c].color : '#888');

  // --- one line per car, coloured by compound per segment ---
  const drawCar = (carId, chosen) => {
    // Rivals are faded hard so the chosen car reads clearly through the crossfire of
    // position swaps (flattened pace makes the field shuffle a lot).
    const alpha = chosen ? 1 : 0.22;
    ctx.lineJoin = 'round';
    // white halo under the chosen line so it stays visible over any compound colour
    if (chosen) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 5.5;
      ctx.beginPath();
      for (let l = 0; l <= upto; l++) {
        const s = race.laps[l][carId];
        if (!s) continue;
        if (l === 0) ctx.moveTo(xOf(l), yOf(s.pos)); else ctx.lineTo(xOf(l), yOf(s.pos));
      }
      ctx.stroke();
    }
    ctx.lineWidth = chosen ? 3 : 1.2;
    for (let l = 0; l < upto; l++) {
      const a = race.laps[l][carId];
      const b = race.laps[l + 1][carId];
      if (!a || !b) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = compoundColor(b.compound); // segment coloured by the tyre run into it
      ctx.beginPath();
      ctx.moveTo(xOf(l), yOf(a.pos));
      ctx.lineTo(xOf(l + 1), yOf(b.pos));
      ctx.stroke();
    }
    // pit markers
    const pits = race.executedPits[carId] || [];
    for (const pl of pits) {
      if (pl > upto) continue;
      const s = race.laps[pl][carId];
      if (!s) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(xOf(pl), yOf(s.pos), chosen ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill();
    }
    // chosen-car label dot at the current lap
    if (chosen && upto >= 0) {
      const s = race.laps[upto][carId];
      if (s) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#e10600';
        ctx.beginPath(); ctx.arc(xOf(upto), yOf(s.pos), 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
  };

  for (let c = 0; c < numCars; c++) if (c !== chosenCarId) drawCar(c, false);
  drawCar(chosenCarId, true); // chosen car on top

  // --- playhead ---
  ctx.globalAlpha = 1;
  const px = xOf(Math.min(lap, totalLaps));
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px, PAD.top); ctx.lineTo(px, PAD.top + plotH); ctx.stroke();

  // --- compound legend (only the compounds actually on track this race) ---
  const present = new Set();
  const samples = [1, Math.floor(totalLaps / 3), Math.floor((2 * totalLaps) / 3), totalLaps];
  for (const l of samples) {
    const snap = race.laps[l];
    if (!snap) continue;
    for (let c = 0; c < numCars; c++) if (snap[c]) present.add(snap[c].compound);
  }
  const order = ['soft', 'medium', 'hard', 'intermediate', 'wet'].filter((c) => present.has(c));
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lx = PAD.left + 4;
  const ly = PAD.top + 6;
  for (const c of order) {
    // Real Pirelli C-number when this track's allocation has been resolved (compounds.js sets
    // constants.compounds[label].compound); falls back to the plain label otherwise.
    const label = constants.compounds[c]?.compound || c;
    ctx.fillStyle = compoundColor(c);
    ctx.beginPath(); ctx.arc(lx + 4, ly, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 0.5; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(label, lx + 11, ly);
    lx += 20 + ctx.measureText(label).width;
  }

  ctx.globalAlpha = 1;
}
