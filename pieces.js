// The chocolate shell as separate rigid slabs. While attached, each slab rides the soft core (its frame is read from four
// points bound to the lattice). Joints between touching slabs break when they are pulled or twisted apart past a limit; once
// enough of a slab's joints are gone it comes free and falls as a rigid body.
export class Pieces {
  constructor(man, A, level, opts = {}) {
    this.P = man.pieces; this.level = level;
    this.pairs = man.pairs.map(([a, b]) => ({ a, b }));
    this.opts = Object.assign({ strainLimit: 0.11, angLimit: 0.25, g: 9.8, kick: 1.4, concentrate: 0.4, tip: 0.4, sScale: 0.5, grains: 60, shield: 1.1, compress: 0.15, maxFragment: 14 }, opts);
    this.c0 = Array.from({ length: this.P }, (_, k) => A(`piece${k}.c`));
    this.buf = new Float32Array(this.P * 12);
    this.state = Array.from({ length: this.P }, (_, k) => ({ k, free: false, pos: [...this.c0[k]], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], prev: [...this.c0[k]], still: 0, asleep: false, deg: 0, broken: 0, hull: [], open: 0, stuck: false, jq: Pieces.randQ(0.14), lastHit: 0 }));
    for (const p of this.pairs) { p.d0 = Math.hypot(...this.c0[p.a].map((x, i) => x - this.c0[p.b][i])); p.broken = false; this.state[p.a].deg++; this.state[p.b].deg++; }
    this.adj = Array.from({ length: this.P }, () => []); this.pairs.forEach((p, i) => { this.adj[p.a].push(i); this.adj[p.b].push(i); });
    this.nrm = this.c0.map((c) => { const n = [c[0] / 1.04, c[1] / 0.81, c[2] / 1.04], l = Math.hypot(...n) || 1; return [n[0] / l, n[1] / l, n[2] / l]; });
    for (const p of this.pairs) { const a = this.c0[p.a], b = this.c0[p.b]; p.mid = a.map((x, i) => (x + b[i]) / 2); const n = this.nrm[p.a], u = a.map((x, i) => b[i] - x), l = Math.hypot(...u) || 1;
      const t = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]], tl = Math.hypot(...t) || 1; p.tan = t.map((x) => x / tl); }      // the crack line runs across the bond and along the shell
    for (const p of this.pairs) { p.near = []; p.shade = []; }
    this.pairs.forEach((p, i) => this.pairs.forEach((q, j) => {                                // where a break at p raises (tip) or lowers (flanks) the load on bond q
      if (i === j) return; const r = q.mid.map((x, k) => x - p.mid[k]), dt = r[0] * p.tan[0] + r[1] * p.tan[1] + r[2] * p.tan[2], al = Math.abs(dt), pp = Math.hypot(r[0] - dt * p.tan[0], r[1] - dt * p.tan[1], r[2] - dt * p.tan[2]);
      if (al < 0.4 && pp < 0.14) p.near.push([j, al, pp]); else if (al < 0.22 && pp < 0.36) p.shade.push(j);
    }));
    this.groups = []; this.flaws();
    for (let k = 0; k < this.P; k++) {                        // a handful of extreme vertices per slab for floor contact
      const pos = A(`piece${k}.pos`), n = pos.length / 3, dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1]], best = [];
      for (const d of dirs) { let bi = 0, bv = -1e9; for (let v = 0; v < n; v++) { const s = pos[v * 3] * d[0] + pos[v * 3 + 1] * d[1] + pos[v * 3 + 2] * d[2]; if (s > bv) { bv = s; bi = v; } } best.push([pos[bi * 3], pos[bi * 3 + 1], pos[bi * 3 + 2]]); }
      this.state[k].hull = best; let r = 0; for (const h of best) r = Math.max(r, Math.hypot(...h)); this.state[k].rad = r;
    }
    this.events = []; this.armed = false; this.T = [0, 0, 0];
    for (const s of this.state) { s.off = [0, 0, 0]; s.R0 = [1, 0, 0, 0, 1, 0, 0, 0, 1]; s.hold = 0.04 + Math.random() * 0.1; s.iso = 0; }
  }
  // Called once the fruit has settled: remember each slab's pose so that this exact pose is drawn as the undisturbed shell
  calibrate(sim) {
    sim.sample(this.level.extra, this.buf); const T = [0, 0, 0]; let n = 0;
    for (const s of this.state) { if (s.free) continue; const b = s.k * 12, c0 = this.c0[s.k]; s.pos0 = [this.buf[b], this.buf[b + 1], this.buf[b + 2]]; s.R0 = Pieces.fromFrame(s.pos0, [this.buf[b + 3], this.buf[b + 4], this.buf[b + 5]], [this.buf[b + 6], this.buf[b + 7], this.buf[b + 8]], [this.buf[b + 9], this.buf[b + 10], this.buf[b + 11]]); for (let a = 0; a < 3; a++) T[a] += s.pos0[a] - c0[a]; n++; }
    for (let a = 0; a < 3; a++) T[a] /= Math.max(1, n); this.T = T;
    for (const s of this.state) { if (s.free) continue; const c0 = this.c0[s.k]; s.off = [s.pos0[0] - c0[0] - T[0], s.pos0[1] - c0[1] - T[1], s.pos0[2] - c0[2] - T[2]]; }
    for (const q of this.pairs) { const A = this.state[q.a], B = this.state[q.b]; q.d0 = Math.hypot(this.c0[q.a][0] - this.c0[q.b][0], this.c0[q.a][1] - this.c0[q.b][1], this.c0[q.a][2] - this.c0[q.b][2]); }
    this.armed = true;
  }
  static randQ(a) { const ax = [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], l = Math.hypot(...ax) || 1, ang = (Math.random() * 2 - 1) * a, s = Math.sin(ang / 2); return [ax[0] / l * s, ax[1] / l * s, ax[2] / l * s, Math.cos(ang / 2)]; }
  static strength(f = 1) { return (0.8 + 1.0 * Math.pow(-Math.log(1 - Math.random() * 0.999), 0.4)) * f; }                  // brittle: a scatter of strengths with a few weak flaws
  static vn(x, y, z) { const h = (i, j, k) => { const t = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return t - Math.floor(t); }, ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz), L = (a, b, t) => a + (b - a) * t;
    return L(L(L(h(ix, iy, iz), h(ix + 1, iy, iz), sx), L(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), sx), sy), L(L(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), sx), L(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), sx), sy), sz); }
  flaws() {                                                                   // a fresh random grain structure every time (cast shells are never the same): bonds between grains are weak, bonds inside a grain strong
    const P = this.P, nG = this.opts.grains, gs = [], pick = () => this.c0[Math.floor(Math.random() * P)];
    for (let g = 0; g < nG; g++) { let best = null, bd = -1; for (let t = 0; t < 8; t++) { const c = pick(), d = gs.reduce((m, q) => Math.min(m, Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2])), 9); if (d > bd) { bd = d; best = c; } } gs.push(best); }
    const grain = this.c0.map((c) => { let bi = 0, bd = 1e9; gs.forEach((q, i) => { const d = Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]) * (0.8 + Math.random() * 0.4); if (d < bd) { bd = d; bi = i; } }); return bi; });
    this.grain = grain;
    for (const p of this.pairs) {
      const y = p.mid[1], across = grain[p.a] !== grain[p.b];
      p.str = Pieces.strength((across ? 0.55 : 2.0) * this.opts.sScale * (y < -0.3 ? 2.4 : 1)); p.broken = false;   // the rim that sits on the plate is held by it
    }
  }
  reset() { this.armed = false; this.groups = []; for (const s of this.state) { s.hold = 0.04 + Math.random() * 0.1; s.iso = 0; s.free = false; s.asleep = false; s.pos = [...this.c0[s.k]]; s.prev = [...this.c0[s.k]]; s.broken = 0; s.open = 0; s.stuck = false; s.jq = Pieces.randQ(0.14); s.R = [1, 0, 0, 0, 1, 0, 0, 0, 1]; s.q = [0, 0, 0, 1]; } this.flaws(); }
  static fromFrame(p0, p1, p2, p3) {                          // rotation from three skinned axis points (Gram-Schmidt)
    let ex = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], ey = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const nz = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }; ex = nz(ex);
    const d = ey[0] * ex[0] + ey[1] * ex[1] + ey[2] * ex[2]; ey = nz([ey[0] - d * ex[0], ey[1] - d * ex[1], ey[2] - d * ex[2]]);
    const ez = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    return [ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]];            // row-major, columns are the axes
  }
  static quatFrom(R) {
    const t = R[0] + R[4] + R[8]; let x, y, z, w;
    if (t > 0) { const s = Math.sqrt(t + 1) * 2; w = s / 4; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s; }
    else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; w = (R[7] - R[5]) / s; x = s / 4; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s; }
    else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = s / 4; z = (R[5] + R[7]) / s; }
    else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = s / 4; }
    const l = Math.hypot(x, y, z, w) || 1; return [x / l, y / l, z / l, w / l];
  }
  // Fracture. Every bond between two touching elements carries the strain and twist that the soft core imposes on it; a bond has its own random
  // strength (brittle, Weibull-like), gets loaded harder as its elements lose other bonds, and weakens its neighbours when it goes, so a crack runs
  // where the core pulls hardest. What is left are clusters of elements that are still bonded to each other. A cluster that has been cut off from
  // the main shell either sticks to the core (if it is being pressed into it) or comes loose and falls as one rigid body.
  update(sim, dt, hits = []) {
    const { buf, state, pairs, opts } = this; this.events.length = 0;
    sim.sample(this.level.extra, buf);
    for (const s of state) {
      if (s.free) continue; const b = s.k * 12;
      s.prev = s.pos; s.pos = [buf[b] - s.off[0], buf[b + 1] - s.off[1], buf[b + 2] - s.off[2]];
      const Rw = Pieces.fromFrame([buf[b], buf[b + 1], buf[b + 2]], [buf[b + 3], buf[b + 4], buf[b + 5]], [buf[b + 6], buf[b + 7], buf[b + 8]], [buf[b + 9], buf[b + 10], buf[b + 11]]), R0 = s.R0;
      const R = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = Rw[i * 3] * R0[j * 3] + Rw[i * 3 + 1] * R0[j * 3 + 1] + Rw[i * 3 + 2] * R0[j * 3 + 2];      // Rw * R0^T: the turn since the settled pose
      s.R = this.armed ? R : [1, 0, 0, 0, 1, 0, 0, 0, 1]; s.q = Pieces.quatFrom(s.R);
      if (s.stuck || s.broken > 0) { const k = Math.min(1, s.broken / 2) * (s.stuck ? 1 : 0.5); s.q = Pieces.qmul(s.q, [s.jq[0] * k, s.jq[1] * k, s.jq[2] * k, 1]); const l = Math.hypot(...s.q) || 1; s.q = s.q.map((x) => x / l); }   // a cracked element sits a little askew
    }
    if (this.armed) {
      for (const p of pairs) {
        if (p.broken) continue; const A = state[p.a], B = state[p.b]; if (A.free || B.free) { p.broken = true; continue; }
        const d = Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1], A.pos[2] - B.pos[2]), e = d / p.d0 - 1, strain = e > 0 ? e : -e * opts.compress;     // pulled apart counts fully, pushed together less
        let tr = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += A.R[i * 3 + j] * B.R[i * 3 + j];       // trace(A^T B)
        const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))), load = 1 + opts.concentrate * Math.max(A.broken / A.deg, B.broken / B.deg) ** 2;
        const m = (strain / opts.strainLimit + ang / opts.angLimit) * load;
        p.metric = m; const frac = Math.min(1, m / p.str) * Math.min(1, Math.max(0, (m - 0.08) / 0.12)); if (frac > A.open) A.open = frac; if (frac > B.open) B.open = frac;      // hairlines only where the core is really working the shell
        if (m > p.str) {
          p.broken = true; A.broken++; B.broken++; A.open = B.open = Math.max(A.open, 0.9);
          for (const q of this.adj[p.a]) if (!pairs[q].broken) pairs[q].str *= 0.93;                                        // the crack runs on...
          for (const q of this.adj[p.b]) if (!pairs[q].broken) pairs[q].str *= 0.93;
          for (const q of p.shade) if (!pairs[q].broken) pairs[q].str *= opts.shield;                                       // beside it the load is taken off
          for (const [q, along, perp] of p.near) if (!pairs[q].broken) pairs[q].str *= 1 - opts.tip * (1 - along / 0.4) * (1 - perp / 0.14);     // ...mostly straight on, along the line of the break
          this.events.push({ a: p.a, b: p.b, at: [(A.pos[0] + B.pos[0]) / 2, (A.pos[1] + B.pos[1]) / 2, (A.pos[2] + B.pos[2]) / 2], strength: Math.min(1, m / 3) });
        }
      }
      if (sim.plateLoose) { for (const s of state) if (!s.free && (sim.plateLoose(s.k) || (s.broken >= Math.max(2, s.deg * 0.85) && sim.plateHold(s.k) < 0.5 && Math.random() < 0.025))) this.release([s.k], s.pos.slice(), dt); }   // on the crumb: a plate drops when the cake under it has crumbled away, or when it is cracked all round on torn crumb   // on the crumb: a plate only drops when the cake under it has crumbled away
      else this.clusters(dt, hits);
    }
    for (const g of this.groups) if (!g.asleep) this.stepFree(g, dt);
    for (const g of this.groups) this.place(g);
  }
  clusters(dt, hits) {
    const { state, pairs, opts } = this, P = this.P, par = new Int32Array(P).map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (const p of pairs) if (!p.broken) { const a = find(p.a), b = find(p.b); if (a !== b) par[a] = b; }
    const comp = new Map(); for (const s of state) { if (s.free) continue; const r = find(s.k); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(s.k); }
    let main = -1, big = 0; for (const [r, m] of comp) if (m.length > big) { big = m.length; main = r; }
    for (const [r, members] of comp) {
      if (r === main || members.length > opts.maxFragment) { for (const k of members) state[k].iso = 0; continue; }
      if (members.every((k) => state[k].stuck)) continue;
      let pressed = 0, near = 1e9; const com = [0, 0, 0];
      for (const k of members) {
        const s = state[k], c0 = this.c0[k], T = this.T, u = [s.pos[0] - c0[0] - T[0], s.pos[1] - c0[1] - T[1], s.pos[2] - c0[2] - T[2]], n = this.nrm[k];
        pressed = Math.max(pressed, Math.min(1, Math.max(0, (-(u[0] * n[0] + u[1] * n[1] + u[2] * n[2]) - 0.03) / 0.09)));                    // how far the cake has been pushed in under it
        for (const h of hits) near = Math.min(near, Math.hypot(s.pos[0] - h[0], s.pos[1] - h[1], s.pos[2] - h[2]));
        for (let a = 0; a < 3; a++) com[a] += s.pos[a] / members.length;
      }
      for (const k of members) { const s = state[k]; s.iso = (s.iso || 0) + dt; }
      const age = state[members[0]].iso; if (age < state[members[0]].hold) continue;                                  // a short moment, cracked but still in place
      const pStick = Math.min(0.8, pressed * 0.6 + (near < 0.3 ? 0.25 : 0) + Math.max(0, 0.25 - members.length * 0.03));
      if (Math.random() < pStick) { for (const k of members) { state[k].stuck = true; state[k].open = 1; } continue; }    // pressed into the cake: it stays, loose but in place
      this.release(members, com, dt);
    }
  }
  release(members, com, dt) {
    const { state } = this, g = { els: members, pos: [...com], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], asleep: false, still: 0, lastHit: 0, lp: [], lq: [], hull: [], rad: 0 };
    let nrm = [0, 0, 0]; const vel = [0, 0, 0];
    members.forEach((k) => {
      const s = state[k], n = this.nrm[k]; s.free = true; s.open = 1; s.stuck = false;
      g.lp.push([s.pos[0] - com[0], s.pos[1] - com[1], s.pos[2] - com[2]]); g.lq.push(s.q);
      for (let a = 0; a < 3; a++) { nrm[a] += n[a]; vel[a] += (s.prev ? (s.pos[a] - s.prev[a]) / Math.max(dt, 1e-3) : 0) / members.length; }
    });
    const nl = Math.hypot(...nrm) || 1, sz = Math.sqrt(members.length), k = this.opts.kick / sz ** 0.5;
    g.v = [vel[0] * 0.8 + nrm[0] / nl * k + (Math.random() - 0.5) * 0.8, vel[1] * 0.8 + nrm[1] / nl * k * 0.7 + 0.5, vel[2] * 0.8 + nrm[2] / nl * k + (Math.random() - 0.5) * 0.8];
    const sp = 7 / sz; g.w = [(Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp];
    const pts = [];                                                                       // extreme points of the whole fragment, for the floor contact
    members.forEach((k, i) => { const R = Pieces.matFrom(g.lq[i]), lp = g.lp[i]; for (const hv of state[k].hull) pts.push([lp[0] + R[0] * hv[0] + R[1] * hv[1] + R[2] * hv[2], lp[1] + R[3] * hv[0] + R[4] * hv[1] + R[5] * hv[2], lp[2] + R[6] * hv[0] + R[7] * hv[1] + R[8] * hv[2]]); });
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1], [1, 1, -1], [-1, 1, 1], [1, -1, 1], [-1, -1, -1]];
    for (const d of dirs) { let bi = 0, bv = -1e9; pts.forEach((p, i) => { const v = p[0] * d[0] + p[1] * d[1] + p[2] * d[2]; if (v > bv) { bv = v; bi = i; } }); g.hull.push(pts[bi]); }
    for (const h of g.hull) g.rad = Math.max(g.rad, Math.hypot(...h));
    this.groups.push(g); this.events.push({ a: members[0], b: -1, at: com, strength: Math.min(1, 0.5 + members.length * 0.08), freed: true, size: members.length });
  }
  place(g) {                                                    // put every element of a free fragment where the rigid body carries it
    const R = Pieces.matFrom(g.q);
    g.els.forEach((k, i) => { const s = this.state[k], lp = g.lp[i]; s.pos = [g.pos[0] + R[0] * lp[0] + R[1] * lp[1] + R[2] * lp[2], g.pos[1] + R[3] * lp[0] + R[4] * lp[1] + R[5] * lp[2], g.pos[2] + R[6] * lp[0] + R[7] * lp[1] + R[8] * lp[2]]; s.q = Pieces.qmul(g.q, g.lq[i]); });
  }
  stepFree(s, dt) {
    const n = 2, h = Math.min(dt, 0.05) / n, I = 0.4 * s.rad * s.rad;
    for (let it = 0; it < n; it++) {
      s.v[1] -= this.opts.g * h; s.v = s.v.map((x) => x * 0.999); s.w = s.w.map((x) => x * 0.992);
      s.pos = s.pos.map((x, i) => x + s.v[i] * h);
      const wl = Math.hypot(...s.w); if (wl > 1e-6) { const ang = wl * h, ax = s.w.map((x) => x / wl), sn = Math.sin(ang / 2), dq = [ax[0] * sn, ax[1] * sn, ax[2] * sn, Math.cos(ang / 2)], q = s.q; s.q = Pieces.qmul(dq, q); }
      const R = Pieces.matFrom(s.q);
      for (const hv of s.hull) {
        const rx = R[0] * hv[0] + R[1] * hv[1] + R[2] * hv[2], ry = R[3] * hv[0] + R[4] * hv[1] + R[5] * hv[2], rz = R[6] * hv[0] + R[7] * hv[1] + R[8] * hv[2], py = s.pos[1] + ry;
        if (py >= 0.012) continue;
        s.pos[1] += (0.012 - py) * 0.5;
        const vpx = s.v[0] + s.w[1] * rz - s.w[2] * ry, vpy = s.v[1] + s.w[2] * rx - s.w[0] * rz, vpz = s.v[2] + s.w[0] * ry - s.w[1] * rx;
        if (vpy < 0) {                                                             // impulse along +y at the contact (restitution 0.25)
          const rxn = [ry * 0 - rz * 1, rz * 0 - rx * 0, rx * 1 - ry * 0]; const den = 1 + (rxn[0] * rxn[0] + rxn[1] * rxn[1] + rxn[2] * rxn[2]) / I, j = -(1.25) * vpy / den;
          if (j > 0.5 && performance.now() - s.lastHit > 130) { s.lastHit = performance.now(); this.events.push({ a: s.els[0], b: -2, at: s.pos, strength: Math.min(1, j / 3), landed: true }); }
          s.v[1] += j; s.w[0] += rxn[0] * j / I; s.w[1] += rxn[1] * j / I; s.w[2] += rxn[2] * j / I; s.v[0] -= vpx * 0.18; s.v[2] -= vpz * 0.18; s.w = s.w.map((x) => x * 0.93);
        }
      }
    }
    if (Math.hypot(...s.v) < 0.12 && Math.hypot(...s.w) < 0.35) { if (++s.still > 24) { s.asleep = true; s.v = [0, 0, 0]; s.w = [0, 0, 0]; } } else s.still = 0;
  }
  static qmul(a, b) { return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
  static matFrom(q) { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]; }
  get brokenCount() { return this.pairs.filter((p) => p.broken).length; }
  get freeCount() { return this.state.filter((s) => s.free).length; }
  get stuckCount() { return this.state.filter((s) => s.stuck).length; }
}
