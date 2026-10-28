// The cake of the Crisp as bonded particles (a bonded-particle / PBD model). Every particle is tied to its neighbours by
// bonds that hold a rest length; past a small yield the rest length gives way (the crumb is crushed and stays crushed),
// and a bond that is pulled too far snaps. So the cake dents, collapses and tears into ragged, grainy chunks, and a
// particle that has lost all its bonds is a loose crumb. The shell plates ride the particles under them (shape matching).
export class Crumb {
  constructor(rest, s, bind, nb, c0, opts = {}) {
    const N = rest.length / 3; this.N = N; this.s = s; this.rest = rest;
    this.pos = new Float32Array(N * 3); this.prev = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.opts = Object.assign({ gravity: -6, reach: 1.45, tear: 0.16, yieldT: 0.05, yieldC: 0.06, rateC: 0.6, rateT: 0.03, iters: 4, longBonds: 2, friction: 0.85 }, opts);
    this.params = { damp: 0.3, firm: 0.5 }; this.grabs = new Map(); this.floorY = 0;
    this.strain = 0; this.impact = 0; this.snaps = 0; this.volRatio = 1; this.torn = 0;
    // bonds: every pair closer than reach * spacing, found with a grid
    const cs = s * this.opts.reach, cell = new Map(), key = (x, y, z) => (x + 512) * 1048576 + (y + 512) * 1024 + (z + 512);
    for (let i = 0; i < N; i++) { const k = key(Math.floor(rest[i * 3] / cs), Math.floor(rest[i * 3 + 1] / cs), Math.floor(rest[i * 3 + 2] / cs)); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(i); }
    const bi = [], bj = [];
    for (let i = 0; i < N; i++) {
      const cx = Math.floor(rest[i * 3] / cs), cy = Math.floor(rest[i * 3 + 1] / cs), cz = Math.floor(rest[i * 3 + 2] / cs);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = cell.get(key(cx + dx, cy + dy, cz + dz)); if (!l) continue;
        for (const j of l) if (j > i && Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]) < cs) { bi.push(i); bj.push(j); }
      }
    }
    // a few long bonds (2-3 spacings) as well: they carry load across the body, so a handful of iterations keeps it from sagging
    { const cl = s * 3.0, cell2 = new Map(); let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < N; i++) { const k = key(Math.floor(rest[i * 3] / cl), Math.floor(rest[i * 3 + 1] / cl), Math.floor(rest[i * 3 + 2] / cl)); if (!cell2.has(k)) cell2.set(k, []); cell2.get(k).push(i); }
      for (let i = 0; i < N; i++) {
        const cx = Math.floor(rest[i * 3] / cl), cy = Math.floor(rest[i * 3 + 1] / cl), cz = Math.floor(rest[i * 3 + 2] / cl), cand = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const l = cell2.get(key(cx + dx, cy + dy, cz + dz)); if (!l) continue; for (const j of l) { if (j <= i) continue; const d = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]); if (d > s * 2.1 && d < s * 3.0) cand.push(j); } }
        for (let t = 0; t < this.opts.longBonds && cand.length; t++) { const j = cand.splice(Math.floor(rnd() * cand.length), 1)[0]; bi.push(i); bj.push(j); }
      } }
    const M = bi.length; this.M = M; this.bi = Int32Array.from(bi); this.bj = Int32Array.from(bj);
    this.L = new Float32Array(M); this.L0 = new Float32Array(M); this.lim = new Float32Array(M); this.alive = new Uint8Array(M);
    for (let b = 0; b < M; b++) { const i = bi[b], j = bj[b]; this.L0[b] = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]); }
    this.nb = new Uint8Array(N); this.nb0 = new Uint8Array(N);
    for (let b = 0; b < M; b++) { this.nb0[bi[b]]++; this.nb0[bj[b]]++; }
    // collision grid (rebuilt every substep): a hashed cell index, counting sort
    this.HS = 1 << 15; this.cellStart = new Int32Array(this.HS + 1); this.cellIdx = new Int32Array(N); this.sorted = new Int32Array(N); this.hc = new Int32Array(N);
    // plates: the particles bound to each plate, and their rest offsets from the bound centroid
    this.plates = []; const P = c0.length;
    for (let k = 0; k < P; k++) {
      const ids = []; for (let j = 0; j < nb; j++) { const i = bind[k * nb + j]; if (i >= 0) ids.push(i); }
      this.plates.push({ k, c0: c0[k], ids, all: ids.slice(), q: [0, 0, 0, 1], cm0: [0, 0, 0], off: [] });
    }
    this.setMaterial(0.5); this.reset();
  }
  setMaterial(firm) {                                    // firm 0..1: brittle/crumbly .. tough
    this.params.firm = firm; this.tearMul = 0.55 + firm * 0.9;
  }
  reset() {
    const { pos, prev, vel, rest, N } = this;
    let lo = 1e9; for (let i = 0; i < N; i++) lo = Math.min(lo, rest[i * 3 + 1]);
    this.y0 = this.floorY + this.s * 0.5 - lo;
    for (let i = 0; i < N; i++) { pos[i * 3] = rest[i * 3]; pos[i * 3 + 1] = rest[i * 3 + 1] + this.y0; pos[i * 3 + 2] = rest[i * 3 + 2]; }
    prev.set(pos); vel.fill(0); this.grabs.clear(); this.hands = null;
    this.L.set(this.L0); this.alive.fill(1); this.nb.set(this.nb0);
    for (let b = 0; b < this.M; b++) { const u = Math.random(); this.lim[b] = this.opts.tear * (0.5 + 0.9 * u * u); }    // a spread of bond strengths: crumbs, not a clean cut
    for (const pl of this.plates) this.bindPlate(pl, pl.all, true);
    this.torn = 0;
  }
  bindPlate(pl, ids, fromRest) {
    const src = fromRest ? this.rest : this.pos, dy = 0; pl.ids = ids;              // plate rest data in the rest frame (the lift onto the plate shows up in the fit)
    const cm = [0, 0, 0]; for (const i of ids) { cm[0] += src[i * 3]; cm[1] += src[i * 3 + 1] + dy; cm[2] += src[i * 3 + 2]; } for (let a = 0; a < 3; a++) cm[a] /= Math.max(1, ids.length);
    if (fromRest) { pl.cm0 = cm; pl.off = ids.map((i) => [this.rest[i * 3] - cm[0], this.rest[i * 3 + 1] + dy - cm[1], this.rest[i * 3 + 2] - cm[2]]); pl.q = [0, 0, 0, 1]; pl.split = 0; }
  }
  startGrab(id, hit, radius = 0.4) {
    const { pos, N } = this, ids = [], w = [], off = [];
    for (let i = 0; i < N; i++) {
      const dx = pos[i * 3] - hit[0], dy = pos[i * 3 + 1] - hit[1], dz = pos[i * 3 + 2] - hit[2], d = Math.hypot(dx, dy, dz);
      if (d < radius) { const t = 1 - d / radius; ids.push(i); w.push(t * t * (3 - 2 * t)); off.push(dx, dy, dz); }
    }
    const g = { ids, w, off, hit: hit.slice(), finger: hit.slice(), n0: ids.length };
    this.grabs.set(id, g); this.setupHands(); return g;
  }
  endGrab(id) { this.grabs.delete(id); this.setupHands(); }
  flip() {}
  grip() { return 1; }
  gyration() { return 0; }
  step(h) {
    const { pos, prev, vel, N, opts } = this, g = opts.gravity, damp = Math.exp(-(1.5 + this.params.damp * 8) * h);
    for (let i = 0; i < N; i++) {
      const k = i * 3; vel[k] *= damp; vel[k + 1] = vel[k + 1] * damp + g * h; vel[k + 2] *= damp;
      prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
      pos[k] += vel[k] * h; pos[k + 1] += vel[k + 1] * h; pos[k + 2] += vel[k + 2] * h;
    }
    const nd = this.markDamaged();
    for (let it = 0; it < opts.iters; it++) { this.solveGrabs(); this.solveBonds(); if (nd && (it & 1) === 0) this.solveContacts(); this.solveFloor(); }
    let imp = 0;
    let flow = 0;
    for (let i = 0; i < N * 3; i++) { const d = pos[i] - prev[i]; vel[i] = d / h; flow += d < 0 ? -d : d; }
    this.flow = (this.flow || 0) + flow / N;                 // how much the cake is being worked (drives the crackle)
    for (let i = 0; i < N; i++) { const v = -vel[i * 3 + 1]; if (pos[i * 3 + 1] < this.floorY + this.s && v > imp) imp = v; }
    if (imp > this.impact) this.impact = imp;
    this.plasticity();
  }
  solveGrabs() {
    const { pos } = this;
    for (const gr of this.grabs.values()) {
      const { ids, w, off, finger } = gr;
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k] * 3, s = w[k] * 0.6;
        let mx = (finger[0] + off[k * 3] - pos[i]) * s, my = (finger[1] + off[k * 3 + 1] - pos[i + 1]) * s, mz = (finger[2] + off[k * 3 + 2] - pos[i + 2]) * s;
        const ml = Math.hypot(mx, my, mz); if (ml > 0.03) { const c = 0.03 / ml; mx *= c; my *= c; mz *= c; }
        pos[i] += mx; pos[i + 1] += my; pos[i + 2] += mz;
      }
    }
    // two fingers are two hands: each holds its whole half (more firmly away from the middle), so pulling them apart tears the
    // cake somewhere near the middle, where it is weakest, and pushing them together crushes it there
    const hp = this.hands; if (!hp) return;
    const { side, start, wt } = hp, A = hp.a.finger, B = hp.b.finger, da = [A[0] - hp.a0[0], A[1] - hp.a0[1], A[2] - hp.a0[2]], db = [B[0] - hp.b0[0], B[1] - hp.b0[1], B[2] - hp.b0[2]];
    for (let i = 0; i < this.N; i++) {
      const w = wt[i]; if (w <= 0) continue; const d = side[i] ? db : da, k = i * 3;
      let mx = (start[k] + d[0] - pos[k]) * w, my = (start[k + 1] + d[1] - pos[k + 1]) * w, mz = (start[k + 2] + d[2] - pos[k + 2]) * w;
      const ml = Math.hypot(mx, my, mz); if (ml > 0.02) { const c = 0.02 / ml; mx *= c; my *= c; mz *= c; }
      pos[k] += mx; pos[k + 1] += my; pos[k + 2] += mz;
    }
  }
  setupHands() {
    const gs = [...this.grabs.values()]; if (gs.length < 2) { this.hands = null; return; }
    const a = gs[0], b = gs[1], N = this.N, pos = this.pos, mid = [(a.finger[0] + b.finger[0]) / 2, (a.finger[1] + b.finger[1]) / 2, (a.finger[2] + b.finger[2]) / 2];
    let ax = [b.finger[0] - a.finger[0], b.finger[1] - a.finger[1], b.finger[2] - a.finger[2]]; const al = Math.hypot(...ax) || 1; ax = ax.map((x) => x / al);
    const side = new Uint8Array(N), wt = new Float32Array(N), start = Float32Array.from(pos);
    for (let i = 0; i < N; i++) { const t = (pos[i * 3] - mid[0]) * ax[0] + (pos[i * 3 + 1] - mid[1]) * ax[1] + (pos[i * 3 + 2] - mid[2]) * ax[2]; side[i] = t > 0 ? 1 : 0; const u = Math.min(1, Math.max(0, (Math.abs(t) - 0.12) / 0.5)); wt[i] = u * u * (3 - 2 * u) * 0.22; }
    this.hands = { a, b, a0: a.finger.slice(), b0: b.finger.slice(), side, wt, start };
  }
  solveBonds() {
    const { pos, bi, bj, L, alive, M } = this, fw = (this._dir = !this._dir);       // alternate the sweep so no side is favoured
    for (let q = 0; q < M; q++) {
      const b = fw ? q : M - 1 - q;
      if (!alive[b]) continue;
      const i = bi[b] * 3, j = bj[b] * 3, dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const c = (d - L[b]) / d * 0.45;
      pos[i] += dx * c; pos[i + 1] += dy * c; pos[i + 2] += dz * c; pos[j] -= dx * c; pos[j + 1] -= dy * c; pos[j + 2] -= dz * c;
    }
  }
  buildGrid() {
    const { pos, N, HS, cellStart, sorted, hc } = this, cs = this.s * 0.9; this.cs = cs; cellStart.fill(0);
    for (let i = 0; i < N; i++) { const h = this.hash(Math.floor(pos[i * 3] / cs), Math.floor(pos[i * 3 + 1] / cs), Math.floor(pos[i * 3 + 2] / cs)); hc[i] = h; cellStart[h]++; }
    let acc = 0; for (let c = 0; c < HS; c++) { const n = cellStart[c]; cellStart[c] = acc; acc += n; } cellStart[HS] = acc;
    const fill = this._fill || (this._fill = new Int32Array(HS)); fill.set(cellStart.subarray(0, HS));
    for (let i = 0; i < N; i++) sorted[fill[hc[i]]++] = i;
  }
  hash(x, y, z) { return (Math.imul(x, 92837111) ^ Math.imul(y, 689287499) ^ Math.imul(z, 283923481)) & (this.HS - 1); }
  markDamaged() {                                       // only particles that have lost a bond can meet one they are not tied to
    const { nb, nb0, N } = this, d = this._dmg || (this._dmg = new Int32Array(N)); let n = 0;
    for (let i = 0; i < N; i++) if (nb[i] < nb0[i]) d[n++] = i;
    this.nDmg = n; if (n) this.buildGrid(); return n;
  }
  solveContacts() {
    const { pos, cellStart, sorted, cs } = this, dmin = this.s * 0.82, d2min = dmin * dmin, dl = this._dmg, nb = this.nb, nb0 = this.nb0;
    for (let q0 = 0; q0 < this.nDmg; q0++) { const i = dl[q0];
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], cx = Math.floor(x / cs), cy = Math.floor(y / cs), cz = Math.floor(z / cs);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const h = this.hash(cx + dx, cy + dy, cz + dz);
        for (let q = cellStart[h], e = cellStart[h + 1]; q < e; q++) {
          const j = sorted[q]; if (j === i || (j < i && nb[j] < nb0[j])) continue;
          const ex = pos[j * 3] - pos[i * 3], ey = pos[j * 3 + 1] - pos[i * 3 + 1], ez = pos[j * 3 + 2] - pos[i * 3 + 2], d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= d2min || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), c = (dmin - d) / d * 0.5 * 0.7;
          pos[i * 3] -= ex * c; pos[i * 3 + 1] -= ey * c; pos[i * 3 + 2] -= ez * c; pos[j * 3] += ex * c; pos[j * 3 + 1] += ey * c; pos[j * 3 + 2] += ez * c;
        }
      }
    }
  }
  solveFloor() {
    const { pos, prev, N, opts } = this, r = this.s * 0.5, fy = this.floorY + r;
    for (let i = 0; i < N; i++) {
      const k = i * 3; if (pos[k + 1] >= fy) continue;
      pos[k + 1] = fy; pos[k] = prev[k] + (pos[k] - prev[k]) * (1 - opts.friction); pos[k + 2] = prev[k + 2] + (pos[k + 2] - prev[k + 2]) * (1 - opts.friction);
    }
  }
  // the crumb gives way: past the yield, the rest length follows the bond (crushed stays crushed); pulled too far, it snaps
  plasticity() {
    const { pos, bi, bj, L, L0, lim, alive, M, opts, nb } = this; let acc = 0, n = 0, torn = 0; const tm = this.tearMul;
    for (let b = 0; b < M; b++) {
      if (!alive[b]) continue;
      const i = bi[b] * 3, j = bj[b] * 3, ex = pos[j] - pos[i], ey = pos[j + 1] - pos[i + 1], ez = pos[j + 2] - pos[i + 2], d = Math.sqrt(ex * ex + ey * ey + ez * ez), e = d / L[b] - 1;
      acc += Math.abs(e); n++;
      if (d / L0[b] - 1 > lim[b] * tm) { alive[b] = 0; nb[bi[b]]--; nb[bj[b]]--; torn++; continue; }
      if (e < -opts.yieldC) L[b] += (d - L[b] * (1 - opts.yieldC)) * opts.rateC;
      else if (e > opts.yieldT) L[b] += (d - L[b] * (1 + opts.yieldT)) * opts.rateT;
      if (L[b] < L0[b] * 0.55) L[b] = L0[b] * 0.55;
    }
    this.strain = acc / Math.max(1, n); this.torn += torn; this.snaps += torn > 20 ? 1 : 0;
  }
  // a frame (centre and three axis points) for each plate, from the best rigid fit of the particles bound to it
  plateFrames(out) {
    const { pos } = this;
    for (const pl of this.plates) {
      const ids = pl.ids, o = pl.k * 12;
      if (!ids.length) continue;
      let cx = 0, cy = 0, cz = 0; for (const i of ids) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; } cx /= ids.length; cy /= ids.length; cz /= ids.length;
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      ids.forEach((i, k) => { const p = [pos[i * 3] - cx, pos[i * 3 + 1] - cy, pos[i * 3 + 2] - cz], q = pl.off[pl.all.indexOf(i)] || pl.off[k]; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A[r * 3 + c] += p[r] * q[c]; });
      pl.q = Crumb.extractRotation(A, pl.q, 6); const R = Crumb.mat(pl.q);
      // residual of the fit: if the crumb under the plate has torn apart, the plate keeps to the bigger side
      let res = 0; ids.forEach((i) => { const q = pl.off[pl.all.indexOf(i)]; const ex = cx + R[0] * q[0] + R[1] * q[1] + R[2] * q[2] - pos[i * 3], ey = cy + R[3] * q[0] + R[4] * q[1] + R[5] * q[2] - pos[i * 3 + 1], ez = cz + R[6] * q[0] + R[7] * q[1] + R[8] * q[2] - pos[i * 3 + 2]; res += ex * ex + ey * ey + ez * ez; });
      res = Math.sqrt(res / ids.length); pl.res = res;
      if (res > this.s * 0.9 && ids.length > 4) this.splitPlate(pl, cx, cy, cz);
      const d = [pl.c0[0] - pl.cm0[0], pl.c0[1] - pl.cm0[1], pl.c0[2] - pl.cm0[2]];
      const px = cx + R[0] * d[0] + R[1] * d[1] + R[2] * d[2], py = cy + R[3] * d[0] + R[4] * d[1] + R[5] * d[2], pz = cz + R[6] * d[0] + R[7] * d[1] + R[8] * d[2];
      out[o] = px; out[o + 1] = py; out[o + 2] = pz;
      out[o + 3] = px + R[0] * 0.1; out[o + 4] = py + R[3] * 0.1; out[o + 5] = pz + R[6] * 0.1;
      out[o + 6] = px + R[1] * 0.1; out[o + 7] = py + R[4] * 0.1; out[o + 8] = pz + R[7] * 0.1;
      out[o + 9] = px + R[2] * 0.1; out[o + 10] = py + R[5] * 0.1; out[o + 11] = pz + R[8] * 0.1;
    }
    return out;
  }
  splitPlate(pl, cx, cy, cz) {                           // two-means on the bound particles; keep the larger group (its rest centroid and offsets)
    const { pos } = this, ids = pl.ids;
    let far = ids[0], fd = -1; for (const i of ids) { const d = (pos[i * 3] - cx) ** 2 + (pos[i * 3 + 1] - cy) ** 2 + (pos[i * 3 + 2] - cz) ** 2; if (d > fd) { fd = d; far = i; } }
    let a = [pos[far * 3], pos[far * 3 + 1], pos[far * 3 + 2]], b = [2 * cx - a[0], 2 * cy - a[1], 2 * cz - a[2]], ga = [], gb = [];
    for (let it = 0; it < 4; it++) {
      ga = []; gb = []; for (const i of ids) { const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]; ((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2 + (p[2] - a[2]) ** 2 < (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2 + (p[2] - b[2]) ** 2 ? ga : gb).push(i); }
      const m = (g) => { const c = [0, 0, 0]; for (const i of g) { c[0] += pos[i * 3]; c[1] += pos[i * 3 + 1]; c[2] += pos[i * 3 + 2]; } return c.map((x) => x / Math.max(1, g.length)); };
      if (ga.length) a = m(ga); if (gb.length) b = m(gb);
    }
    const keep = ga.length >= gb.length ? ga : gb; if (keep.length < 3) return;
    pl.ids = keep; pl.split++;
    const cm = [0, 0, 0]; for (const i of keep) { const q = pl.off[pl.all.indexOf(i)]; cm[0] += q[0]; cm[1] += q[1]; cm[2] += q[2]; } for (let x = 0; x < 3; x++) cm[x] /= keep.length;
    // re-centre: offsets of the kept particles relative to their own rest centroid
    const newOff = pl.off.map((q) => [q[0] - cm[0], q[1] - cm[1], q[2] - cm[2]]); pl.off = newOff; pl.cm0 = [pl.cm0[0] + cm[0], pl.cm0[1] + cm[1], pl.cm0[2] + cm[2]];
  }
  plateHold(k) {                                         // how well the crumb under a plate still holds together (1 = untouched)
    const pl = this.plates[k]; if (pl.ids.length < 3) return 0;
    let b = 0; for (const i of pl.ids) b += this.nb[i] / Math.max(1, this.nb0[i]); return b / pl.ids.length;
  }
  plateLoose(k) { return this.plateHold(k) < 0.18; }   // the crumb under it has fallen apart: the plate has nothing to hold on to
  sample(S, out) {
    if (S && S.plates) return this.plateFrames(out);
    out.set(this.pos.subarray(0, out.length)); return out;
  }
  // rotation part of A (Mueller et al. 2016), warm-started from q
  static extractRotation(A, q, iters) {
    let [x, y, z, w] = q;
    for (let it = 0; it < iters; it++) {
      const R = Crumb.mat([x, y, z, w]);
      const c0 = [R[0], R[3], R[6]], c1 = [R[1], R[4], R[7]], c2 = [R[2], R[5], R[8]], a0 = [A[0], A[3], A[6]], a1 = [A[1], A[4], A[7]], a2 = [A[2], A[5], A[8]];
      const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], dt = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const t0 = cr(c0, a0), t1 = cr(c1, a1), t2 = cr(c2, a2), om = [t0[0] + t1[0] + t2[0], t0[1] + t1[1] + t2[1], t0[2] + t1[2] + t2[2]];
      const den = Math.abs(dt(c0, a0) + dt(c1, a1) + dt(c2, a2)) + 1e-9; om[0] /= den; om[1] /= den; om[2] /= den;
      const ang = Math.hypot(...om); if (ang < 1e-9) break;
      const s = Math.sin(ang / 2) / ang, dq = [om[0] * s, om[1] * s, om[2] * s, Math.cos(ang / 2)];
      [x, y, z, w] = [dq[3] * x + dq[0] * w + dq[1] * z - dq[2] * y, dq[3] * y - dq[0] * z + dq[1] * w + dq[2] * x, dq[3] * z + dq[0] * y - dq[1] * x + dq[2] * w, dq[3] * w - dq[0] * x - dq[1] * y - dq[2] * z];
      const l = Math.hypot(x, y, z, w); x /= l; y /= l; z /= l; w /= l;
    }
    return [x, y, z, w];
  }
  static mat(q) { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]; }
}
