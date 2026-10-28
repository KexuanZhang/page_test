// Corotational XPBD on the tetrahedral lattice.
// Per tet: a deviatoric constraint ||F - R|| (R = rotation from a warm-started extraction) and an elastic volume
// constraint det(F) - 1. Rind is leathery, pith is firmer than pulp, pulp is very soft with a springy volume.
import { REGION } from './regions.js';

const H_REF = 1 / 60 / 10;       // stiffness numbers below are tuned for 10 substeps at 60 Hz

export class Sim {
  constructor(L, opts = {}) {
    this.L = L; this.opts = opts; const N = L.N, NT = L.NT;
    this.N = N; this.NT = NT;
    this.pos = new Float32Array(N * 3); this.prev = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.rest = L.rest;
    this.invMass = new Float32Array(N);
    for (let i = 0; i < N; i++) this.invMass[i] = 1 / Math.max(L.nodeMass[i], 1e-6);
    // how far a finger can stretch each kind of material before it lets go: pulp clings then slips, rind holds
    const holdD = opts.hold || [6, 3, 1.3];
    // node groups: 2 = flesh, 0 = shell (rind and pith). Used so that grabbing the rind does not drag the soft flesh with it.
    this.group = new Uint8Array(N); { const c2 = new Uint16Array(N), c0 = new Uint16Array(N); for (let t = 0; t < NT; t++) for (let k = 0; k < 4; k++) { const n = L.tetIdx[t * 4 + k]; if (L.region[t] === 2) c2[n]++; else c0[n]++; } for (let i = 0; i < N; i++) this.group[i] = c2[i] > c0[i] ? 2 : 0; }
    this.useGroups = !!opts.groups;
    this.hold = new Float32Array(N).fill(6);
    for (let t = 0; t < NT; t++) for (let k = 0; k < 4; k++) { const n = L.tetIdx[t * 4 + k], r = L.region[t], d = holdD[r]; if (d < this.hold[n]) this.hold[n] = d; }
    for (let t = 0; t < NT; t++) if (L.region[t] === REGION.RIND) for (let k = 0; k < 4; k++) this.hold[L.tetIdx[t * 4 + k]] = 6;
    // plasticity: flesh that is pushed past its yield strain keeps part of the new shape (the rest shape follows it)
    this.plastic = opts.plastic || null;
    this.minv0 = Float32Array.from(L.minv); this.minv = Float32Array.from(L.minv);
    this.dm = new Float32Array(NT * 9);
    for (let t = 0; t < NT; t++) { const m = L.minv, o = t * 9; const det = m[o] * (m[o + 4] * m[o + 8] - m[o + 5] * m[o + 7]) + m[o + 1] * (m[o + 5] * m[o + 6] - m[o + 3] * m[o + 8]) + m[o + 2] * (m[o + 3] * m[o + 7] - m[o + 4] * m[o + 6]);
      const d = this.dm; d[o] = (m[o + 4] * m[o + 8] - m[o + 5] * m[o + 7]) / det; d[o + 1] = (m[o + 2] * m[o + 7] - m[o + 1] * m[o + 8]) / det; d[o + 2] = (m[o + 1] * m[o + 5] - m[o + 2] * m[o + 4]) / det;
      d[o + 3] = (m[o + 5] * m[o + 6] - m[o + 3] * m[o + 8]) / det; d[o + 4] = (m[o] * m[o + 8] - m[o + 2] * m[o + 6]) / det; d[o + 5] = (m[o + 2] * m[o + 3] - m[o] * m[o + 5]) / det;
      d[o + 6] = (m[o + 3] * m[o + 7] - m[o + 4] * m[o + 6]) / det; d[o + 7] = (m[o + 1] * m[o + 6] - m[o] * m[o + 7]) / det; d[o + 8] = (m[o] * m[o + 4] - m[o + 1] * m[o + 3]) / det; }
    this.dm0 = Float32Array.from(this.dm);
    this.quat = new Float32Array(NT * 4); for (let t = 0; t < NT; t++) this.quat[t * 4 + 3] = 1;
    this.lamD = new Float32Array(NT); this.lamH = new Float32Array(NT);
    // reference effective mass per tet, so that "relative compliance" means the same thing everywhere
    this.sRef = new Float32Array(NT);
    for (let t = 0; t < NT; t++) {
      let s = 0;
      for (let i = 0; i < 3; i++) { const m = (L.minv[t * 9 + i * 3] ** 2 + L.minv[t * 9 + i * 3 + 1] ** 2 + L.minv[t * 9 + i * 3 + 2] ** 2) / 3; s += this.invMass[L.tetIdx[t * 4 + 1 + i]] * m; }
      const m0 = 0; let sum = 0; for (let i = 0; i < 3; i++) sum += L.minv[t * 9 + i] + L.minv[t * 9 + 3 + i] + L.minv[t * 9 + 6 + i];
      s += this.invMass[L.tetIdx[t * 4]] * (sum * sum / 9 + m0);
      this.sRef[t] = s;
    }
    this.params = { firm: 0.5, damp: 0.3, gravity: opts.gravity ?? -20, substeps: 10 };
    this.bottom = 0; for (let i = 0; i < L.contact.n; i++) this.bottom = Math.max(this.bottom, -L.contact.pts[i * 3 + 1]);
    this.strain = 0; this.nFlesh = 0; for (let t = 0; t < NT; t++) if (L.region[t] === (opts.strainRegion ?? 2)) this.nFlesh++;
    this.grabs = new Map();
    this.floorY = 0; this.wall = 3.4; this.friction = opts.friction ?? 0.9; this.adhesion = opts.adhesion ?? 0; this.dragScale = opts.drag ?? 1;
    this.strainRegion = opts.strainRegion ?? 2; this.flipState = null; this.verticalGrab = !!opts.verticalGrab;
    // stickiness: the bottom layer of nodes remembers where it last rested and is pulled back to it when something tugs
    // the body upward, until the tug is strong enough to peel it off
    this.tether = opts.tether || null; this.tetDmg = new Float32Array(NT); this.nodeDmg = new Float32Array(N);
    if (this.tether) { let mn = 1e9; for (let i = 0; i < N; i++) mn = Math.min(mn, L.rest[i * 3 + 1]);
      this.tnodes = []; for (let i = 0; i < N; i++) if (L.rest[i * 3 + 1] < mn + this.tether.layers * L.c) this.tnodes.push(i);
      this.anchor = new Float32Array(N * 3); this.latched = new Uint8Array(N); }
    this.relD = new Float32Array(3); this.relH = new Float32Array(3);
    this.setMaterial(0.5);
    this.impact = 0; this.snaps = 0; this.volRatio = 1;
    this.restVol = 0; for (let t = 0; t < NT; t++) this.restVol += L.V0[t] * L.frac[t];
    this.reset();
  }
  // firm in 0..1: "trembling" to "set". Numbers are relative compliances (1 = as soft as the node mass lets it be).
  setMaterial(firm) {
    const k = Math.pow(10, 2 * (0.5 - firm));
    this.params.firm = firm;
    if (this.opts.mat) { this.opts.mat(k, this.relD, this.relH); return; }
    this.relD[REGION.RIND] = 0.02; this.relH[REGION.RIND] = 0.02;
    this.relD[REGION.PITH] = 3 * k; this.relH[REGION.PITH] = 1.5 * Math.pow(k, 0.5);
    this.relD[REGION.PULP] = 1800 * k; this.relH[REGION.PULP] = 260 * Math.pow(k, 0.6);
  }
  reset(lift = 0.02, spin = false) {
    const { pos, vel, rest, N } = this;
    const y0 = this.bottom + lift;
    for (let i = 0; i < N; i++) { pos[i * 3] = rest[i * 3]; pos[i * 3 + 1] = rest[i * 3 + 1] + y0; pos[i * 3 + 2] = rest[i * 3 + 2]; }
    vel.fill(0); this.prev.set(pos); this.lamD.fill(0); this.lamH.fill(0);
    this.minv.set(this.minv0); this.dm.set(this.dm0); this.tetDmg.fill(0);
    this.quat.fill(0); for (let t = 0; t < this.NT; t++) this.quat[t * 4 + 3] = 1;
    this.grabs.clear();
  }
  startGrab(id, hit, radius = 0.34, group = -1) {
    const { pos, N } = this, ids = [], w = [], off = [];
    let want = -1;
    if (this.useGroups) {                                  // the material under the fingertip decides what gets held
      let bi = 0, bd = 1e9; for (let i = 0; i < N; i++) { const d = Math.hypot(pos[i * 3] - hit[0], pos[i * 3 + 1] - hit[1], pos[i * 3 + 2] - hit[2]); if (d < bd) { bd = d; bi = i; } }
      want = group >= 0 && group < 255 ? group : this.group[bi]; if (want === 0) radius *= 1.35;
    }
    for (let i = 0; i < N; i++) {
      if (want >= 0 && this.group[i] !== want) continue;
      const dx = pos[i * 3] - hit[0], dy = pos[i * 3 + 1] - hit[1], dz = pos[i * 3 + 2] - hit[2], d = Math.hypot(dx, dy, dz);
      if (d < radius) { const s = 1 - d / radius; ids.push(i); w.push(s * s * (3 - 2 * s)); off.push(dx, dy, dz); }
    }
    const g = { ids, w, off, hit: hit.slice(), finger: hit.slice(), n0: ids.length };
    this.grabs.set(id, g); return g;
  }
  endGrab(id) { this.grabs.delete(id); }
  // Turn the whole thing over: a 180 degree rotation about its long horizontal axis, lifted clear of the floor and set
  // back down, as a kinematic move (so it always works, whatever shape it is in).
  flip() {
    const { pos, rest, N } = this; this.grabs.clear();
    let cx = 0, cy = 0, cz = 0; for (let i = 0; i < N; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; } cx /= N; cy /= N; cz /= N;
    // long axis: from the rest-frame -x end to the +x end, taken from where those nodes are now
    let ax = 0, az = 0, a = 0, b = 0; let rmin = 1e9, rmax = -1e9; for (let i = 0; i < N; i++) { rmin = Math.min(rmin, rest[i * 3]); rmax = Math.max(rmax, rest[i * 3]); }
    const lo = rmin + (rmax - rmin) * 0.25, hi = rmax - (rmax - rmin) * 0.25; let lx = 0, lz = 0, hx = 0, hz = 0;
    for (let i = 0; i < N; i++) { if (rest[i * 3] < lo) { lx += pos[i * 3]; lz += pos[i * 3 + 2]; a++; } else if (rest[i * 3] > hi) { hx += pos[i * 3]; hz += pos[i * 3 + 2]; b++; } }
    ax = hx / b - lx / a; az = hz / b - lz / a; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    this.flipState = { t: 0, dur: 0.7, c: [cx, cy, cz], axis: [ax, 0, az], p0: Float32Array.from(pos) };
  }
  stepFlip(h) {
    const f = this.flipState, { pos, prev, vel, N } = this; f.t += h * 6;           // called once per substep; 6 ~ the usual substep count per 1/60 s frame
    const s = Math.min(1, f.t / f.dur), e = s * s * (3 - 2 * s), th = Math.PI * e, c = Math.cos(th), sn = Math.sin(th), [ax, , az] = f.axis, [cx, cy, cz] = f.c;
    let minY = 1e9; const q = this._fq || (this._fq = new Float32Array(N * 3));
    for (let i = 0; i < N; i++) {
      const x = f.p0[i * 3] - cx, y = f.p0[i * 3 + 1] - cy, z = f.p0[i * 3 + 2] - cz, d = ax * x + az * z;
      // Rodrigues rotation about the horizontal axis (ax, 0, az) through the centroid
      const kx = -az * y * 0 + (0 * z - az * y) , ky = az * x - ax * z, kz = ax * y - 0 * x;
      q[i * 3] = cx + x * c + kx * sn + ax * d * (1 - c); q[i * 3 + 1] = cy + y * c + ky * sn; q[i * 3 + 2] = cz + z * c + kz * sn + az * d * (1 - c);
      if (q[i * 3 + 1] < minY) minY = q[i * 3 + 1];
    }
    const lift = Math.sin(Math.PI * s) * 0.55, dy = Math.max(lift, this.floorY + 0.02 - minY);
    for (let i = 0; i < N; i++) { prev[i * 3] = pos[i * 3]; prev[i * 3 + 1] = pos[i * 3 + 1]; prev[i * 3 + 2] = pos[i * 3 + 2]; pos[i * 3] = q[i * 3]; pos[i * 3 + 1] = q[i * 3 + 1] + dy; pos[i * 3 + 2] = q[i * 3 + 2]; vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0; }
    this.quat.fill(0); for (let t = 0; t < this.NT; t++) this.quat[t * 4 + 3] = 1;      // rotations are re-extracted from the new pose
    if (s >= 1) { this.flipState = null; this.lamD.fill(0); this.lamH.fill(0); }
  }
  // share of the nodes under a finger that are still gripping (100 % when nothing is held)
  // per node damage 0..1 (max strain any touching tet has been through), and the total newly cracked since the last call
  damage(scale) {
    const { nodeDmg, tetDmg, L } = this, ti = L.tetIdx; nodeDmg.fill(0); let sum = 0;
    for (let t = 0; t < this.NT; t++) { const d = Math.min(1, tetDmg[t] * scale); if (d <= 0) continue; sum += d; for (let k = 0; k < 4; k++) { const n = ti[t * 4 + k]; if (d > nodeDmg[n]) nodeDmg[n] = d; } }
    const fresh = Math.max(0, sum - (this._dsum || 0)); this._dsum = sum; return fresh;
  }
  grip() {
    let held = 0, total = 0;
    for (const g of this.grabs.values()) { total += g.n0; for (let k = 0; k < g.w.length; k++) if (g.w[k] > 0) held++; }
    return total ? held / total : 1;
  }
  applyGrabs(strength) {
    const { pos } = this;
    for (const g of this.grabs.values()) {
      const { ids, w, off, finger } = g;
      for (let k = 0; k < ids.length; k++) {
        if (w[k] <= 0) continue;
        const i = ids[k] * 3, s = Math.min(1, w[k] * strength);
        const ex = finger[0] + off[k * 3] - pos[i], ey = finger[1] + off[k * 3 + 1] - pos[i + 1], ez = finger[2] + off[k * 3 + 2] - pos[i + 2];
        const hd = this.hold[ids[k]];
        const tx = finger[0] - g.hit[0], ty = finger[1] - g.hit[1], tz = finger[2] - g.hit[2];
        if (tx * tx + ty * ty + tz * tz > hd * hd || ex * ex + ey * ey + ez * ez > 1.0 * hd * hd) { w[k] = 0; this.snaps++; continue; }   // stretched too far: lets go
        let mx = this.verticalGrab ? 0 : ex * s, my = ey * s, mz = this.verticalGrab ? 0 : ez * s;   // a press-only grab never drags the thing sideways
        const ml = Math.hypot(mx, my, mz);
        if (ml > 0.05) { const c = 0.05 / ml; mx *= c; my *= c; mz *= c; }
        pos[i] += mx; pos[i + 1] += my; pos[i + 2] += mz;
      }
    }
  }
  step(h) {
    if (this.flipState) { this.stepFlip(h); return; }
    const { pos, prev, vel, invMass, N, NT, L, quat, lamD, lamH, sRef } = this;
    const { tetIdx, region } = L, minv = this.minv, dm = this.dm, plastic = this.plastic, sReg = this.strainRegion;
    const damp = Math.exp(-(0.08 + this.params.damp * 5) * h), g = this.params.gravity;
    const hs = (H_REF / h) ** 2;                      // keep stiffness independent of the substep count
    const grabbed = this.grabs.size > 0;
    for (let i = 0; i < N; i++) {
      const k = i * 3;
      prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
      vel[k + 1] += g * h; vel[k] *= damp; vel[k + 1] *= damp; vel[k + 2] *= damp;
      pos[k] += vel[k] * h; pos[k + 1] += vel[k + 1] * h; pos[k + 2] += vel[k + 2] * h;
    }
    if (grabbed) this.applyGrabs(0.5);
    lamD.fill(0); lamH.fill(0);
    let vol = 0, strainAcc = 0;
    for (let t = 0; t < NT; t++) {
      const i0 = tetIdx[t * 4], i1 = tetIdx[t * 4 + 1], i2 = tetIdx[t * 4 + 2], i3 = tetIdx[t * 4 + 3];
      const a0 = i0 * 3, a1 = i1 * 3, a2 = i2 * 3, a3 = i3 * 3, m = t * 9;
      const d1x = pos[a1] - pos[a0], d1y = pos[a1 + 1] - pos[a0 + 1], d1z = pos[a1 + 2] - pos[a0 + 2];
      const d2x = pos[a2] - pos[a0], d2y = pos[a2 + 1] - pos[a0 + 1], d2z = pos[a2 + 2] - pos[a0 + 2];
      const d3x = pos[a3] - pos[a0], d3y = pos[a3 + 1] - pos[a0 + 1], d3z = pos[a3 + 2] - pos[a0 + 2];
      // F columns: f_b = sum_i d_i * minv[i][b]
      const m00 = minv[m], m01 = minv[m + 1], m02 = minv[m + 2], m10 = minv[m + 3], m11 = minv[m + 4], m12 = minv[m + 5], m20 = minv[m + 6], m21 = minv[m + 7], m22 = minv[m + 8];
      const f0x = d1x * m00 + d2x * m10 + d3x * m20, f0y = d1y * m00 + d2y * m10 + d3y * m20, f0z = d1z * m00 + d2z * m10 + d3z * m20;
      const f1x = d1x * m01 + d2x * m11 + d3x * m21, f1y = d1y * m01 + d2y * m11 + d3y * m21, f1z = d1z * m01 + d2z * m11 + d3z * m21;
      const f2x = d1x * m02 + d2x * m12 + d3x * m22, f2y = d1y * m02 + d2y * m12 + d3y * m22, f2z = d1z * m02 + d2z * m12 + d3z * m22;
      // warm-started rotation extraction (two iterations)
      let qx = quat[t * 4], qy = quat[t * 4 + 1], qz = quat[t * 4 + 2], qw = quat[t * 4 + 3];
      let r0x, r0y, r0z, r1x, r1y, r1z, r2x, r2y, r2z;
      for (let it = 0; it < 2; it++) {
        const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
        r0x = 1 - 2 * (yy + zz); r0y = 2 * (xy + wz); r0z = 2 * (xz - wy);
        r1x = 2 * (xy - wz); r1y = 1 - 2 * (xx + zz); r1z = 2 * (yz + wx);
        r2x = 2 * (xz + wy); r2y = 2 * (yz - wx); r2z = 1 - 2 * (xx + yy);
        const ox = r0y * f0z - r0z * f0y + r1y * f1z - r1z * f1y + r2y * f2z - r2z * f2y;
        const oy = r0z * f0x - r0x * f0z + r1z * f1x - r1x * f1z + r2z * f2x - r2x * f2z;
        const oz = r0x * f0y - r0y * f0x + r1x * f1y - r1y * f1x + r2x * f2y - r2y * f2x;
        const dn = Math.abs(r0x * f0x + r0y * f0y + r0z * f0z + r1x * f1x + r1y * f1y + r1z * f1z + r2x * f2x + r2y * f2y + r2z * f2z) + 1e-9;
        const wx2 = ox / dn, wy2 = oy / dn, wz2 = oz / dn, ang = Math.hypot(wx2, wy2, wz2);
        if (ang < 1e-9) break;
        const s = Math.sin(ang * 0.5) / ang, c = Math.cos(ang * 0.5);
        const nx = c * qx + s * (wx2 * qw + wy2 * qz - wz2 * qy), ny = c * qy + s * (wy2 * qw + wz2 * qx - wx2 * qz),
              nz = c * qz + s * (wz2 * qw + wx2 * qy - wy2 * qx), nw = c * qw - s * (wx2 * qx + wy2 * qy + wz2 * qz);
        const nl = Math.hypot(nx, ny, nz, nw); qx = nx / nl; qy = ny / nl; qz = nz / nl; qw = nw / nl;
      }
      quat[t * 4] = qx; quat[t * 4 + 1] = qy; quat[t * 4 + 2] = qz; quat[t * 4 + 3] = qw;
      {
        const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
        r0x = 1 - 2 * (yy + zz); r0y = 2 * (xy + wz); r0z = 2 * (xz - wy);
        r1x = 2 * (xy - wz); r1y = 1 - 2 * (xx + zz); r1z = 2 * (yz + wx);
        r2x = 2 * (xz + wy); r2y = 2 * (yz - wx); r2z = 1 - 2 * (xx + yy);
      }
      const reg = region[t], sr = sRef[t];
      const w0 = invMass[i0], w1 = invMass[i1], w2 = invMass[i2], w3 = invMass[i3];
      // ---- deviatoric: C = ||F - R||, G = (F - R) / C
      const e0x = f0x - r0x, e0y = f0y - r0y, e0z = f0z - r0z, e1x = f1x - r1x, e1y = f1y - r1y, e1z = f1z - r1z, e2x = f2x - r2x, e2y = f2y - r2y, e2z = f2z - r2z;
      const Cd = Math.sqrt(e0x * e0x + e0y * e0y + e0z * e0z + e1x * e1x + e1y * e1y + e1z * e1z + e2x * e2x + e2y * e2y + e2z * e2z);
      if (reg === sReg) strainAcc += Cd;
      if (reg === sReg || (plastic && reg === plastic.region2)) { const dm0 = this.tetDmg[t]; if (Cd > dm0) this.tetDmg[t] = Cd; }
      if (plastic && (reg === plastic.region || reg === plastic.region2) && Cd > plastic.yield) {
        const gam = Math.min(plastic.cap ?? 0.2, plastic.rate * (1 - plastic.yield / Cd)), o = t * 9;
        const n = [(1 - gam) * dm[o] + gam * (r0x * d1x + r0y * d1y + r0z * d1z), (1 - gam) * dm[o + 1] + gam * (r0x * d2x + r0y * d2y + r0z * d2z), (1 - gam) * dm[o + 2] + gam * (r0x * d3x + r0y * d3y + r0z * d3z),
                   (1 - gam) * dm[o + 3] + gam * (r1x * d1x + r1y * d1y + r1z * d1z), (1 - gam) * dm[o + 4] + gam * (r1x * d2x + r1y * d2y + r1z * d2z), (1 - gam) * dm[o + 5] + gam * (r1x * d3x + r1y * d3y + r1z * d3z),
                   (1 - gam) * dm[o + 6] + gam * (r2x * d1x + r2y * d1y + r2z * d1z), (1 - gam) * dm[o + 7] + gam * (r2x * d2x + r2y * d2y + r2z * d2z), (1 - gam) * dm[o + 8] + gam * (r2x * d3x + r2y * d3y + r2z * d3z)];
        const dt0 = n[0] * (n[4] * n[8] - n[5] * n[7]) + n[1] * (n[5] * n[6] - n[3] * n[8]) + n[2] * (n[3] * n[7] - n[4] * n[6]);
        const dt00 = this.dm0[o] * (this.dm0[o + 4] * this.dm0[o + 8] - this.dm0[o + 5] * this.dm0[o + 7]) + this.dm0[o + 1] * (this.dm0[o + 5] * this.dm0[o + 6] - this.dm0[o + 3] * this.dm0[o + 8]) + this.dm0[o + 2] * (this.dm0[o + 3] * this.dm0[o + 7] - this.dm0[o + 4] * this.dm0[o + 6]);
        let dev = 0, nrm0 = 0; for (let q = 0; q < 9; q++) { dev += (n[q] - this.dm0[o + q]) ** 2; nrm0 += this.dm0[o + q] ** 2; }
        if (dt0 > 0.2 * dt00 && dt0 < 3 * dt00 && dev < (plastic.maxDev ?? 0.6) ** 2 * nrm0) {   // bounded: never flatten or stretch a tet away
          for (let q = 0; q < 9; q++) dm[o + q] = n[q];
          minv[o] = (n[4] * n[8] - n[5] * n[7]) / dt0; minv[o + 1] = (n[2] * n[7] - n[1] * n[8]) / dt0; minv[o + 2] = (n[1] * n[5] - n[2] * n[4]) / dt0;
          minv[o + 3] = (n[5] * n[6] - n[3] * n[8]) / dt0; minv[o + 4] = (n[0] * n[8] - n[2] * n[6]) / dt0; minv[o + 5] = (n[2] * n[3] - n[0] * n[5]) / dt0;
          minv[o + 6] = (n[3] * n[7] - n[4] * n[6]) / dt0; minv[o + 7] = (n[1] * n[6] - n[0] * n[7]) / dt0; minv[o + 8] = (n[0] * n[4] - n[1] * n[3]) / dt0;
        }
      }
      // ---- volume: C = det(F) - 1, G = cofactor(F)
      const c0x = f1y * f2z - f1z * f2y, c0y = f1z * f2x - f1x * f2z, c0z = f1x * f2y - f1y * f2x;     // f1 x f2
      const c1x = f2y * f0z - f2z * f0y, c1y = f2z * f0x - f2x * f0z, c1z = f2x * f0y - f2y * f0x;     // f2 x f0
      const c2x = f0y * f1z - f0z * f1y, c2y = f0z * f1x - f0x * f1z, c2z = f0x * f1y - f0y * f1x;     // f0 x f1
      const det = f0x * c0x + f0y * c0y + f0z * c0z;
      vol += det * L.V0[t] * L.frac[t];
      const Ch = det - 1;
      // gradients: g_i[a] = sum_b G[a][b] * minv[i][b]; G columns are (e0,e1,e2)/Cd or (c0,c1,c2)
      let dD = 0, dH = 0, gD = null;
      const aD = this.relD[reg] * sr * hs, aH = this.relH[reg] * sr * hs;
      let lD = 0, lH = 0;
      const inv = Cd > 1e-7 ? 1 / Cd : 0;
      // node 1..3 gradients for D
      const gdx1 = (e0x * m00 + e1x * m01 + e2x * m02) * inv, gdy1 = (e0y * m00 + e1y * m01 + e2y * m02) * inv, gdz1 = (e0z * m00 + e1z * m01 + e2z * m02) * inv;
      const gdx2 = (e0x * m10 + e1x * m11 + e2x * m12) * inv, gdy2 = (e0y * m10 + e1y * m11 + e2y * m12) * inv, gdz2 = (e0z * m10 + e1z * m11 + e2z * m12) * inv;
      const gdx3 = (e0x * m20 + e1x * m21 + e2x * m22) * inv, gdy3 = (e0y * m20 + e1y * m21 + e2y * m22) * inv, gdz3 = (e0z * m20 + e1z * m21 + e2z * m22) * inv;
      const gdx0 = -(gdx1 + gdx2 + gdx3), gdy0 = -(gdy1 + gdy2 + gdy3), gdz0 = -(gdz1 + gdz2 + gdz3);
      const ghx1 = c0x * m00 + c1x * m01 + c2x * m02, ghy1 = c0y * m00 + c1y * m01 + c2y * m02, ghz1 = c0z * m00 + c1z * m01 + c2z * m02;
      const ghx2 = c0x * m10 + c1x * m11 + c2x * m12, ghy2 = c0y * m10 + c1y * m11 + c2y * m12, ghz2 = c0z * m10 + c1z * m11 + c2z * m12;
      const ghx3 = c0x * m20 + c1x * m21 + c2x * m22, ghy3 = c0y * m20 + c1y * m21 + c2y * m22, ghz3 = c0z * m20 + c1z * m21 + c2z * m22;
      const ghx0 = -(ghx1 + ghx2 + ghx3), ghy0 = -(ghy1 + ghy2 + ghy3), ghz0 = -(ghz1 + ghz2 + ghz3);
      // the deviatoric and volume constraints share nodes and their gradients are not orthogonal, so solve the
      // 2x2 system together (applying them independently over-corrects and rings at the substep rate)
      {
        const a11 = w0 * (gdx0 * gdx0 + gdy0 * gdy0 + gdz0 * gdz0) + w1 * (gdx1 * gdx1 + gdy1 * gdy1 + gdz1 * gdz1) + w2 * (gdx2 * gdx2 + gdy2 * gdy2 + gdz2 * gdz2) + w3 * (gdx3 * gdx3 + gdy3 * gdy3 + gdz3 * gdz3) + aD;
        const a22 = w0 * (ghx0 * ghx0 + ghy0 * ghy0 + ghz0 * ghz0) + w1 * (ghx1 * ghx1 + ghy1 * ghy1 + ghz1 * ghz1) + w2 * (ghx2 * ghx2 + ghy2 * ghy2 + ghz2 * ghz2) + w3 * (ghx3 * ghx3 + ghy3 * ghy3 + ghz3 * ghz3) + aH;
        const a12 = w0 * (gdx0 * ghx0 + gdy0 * ghy0 + gdz0 * ghz0) + w1 * (gdx1 * ghx1 + gdy1 * ghy1 + gdz1 * ghz1) + w2 * (gdx2 * ghx2 + gdy2 * ghy2 + gdz2 * ghz2) + w3 * (gdx3 * ghx3 + gdy3 * ghy3 + gdz3 * ghz3);
        const rD = (Cd > 1e-7 ? -Cd : 0) - aD * lamD[t], rH = -Ch - aH * lamH[t], det2 = a11 * a22 - a12 * a12;
        lD = (rD * a22 - a12 * rH) / det2; lH = (a11 * rH - a12 * rD) / det2;
        lamD[t] += lD; lamH[t] += lH;
      }
      pos[a0] += w0 * (lD * gdx0 + lH * ghx0); pos[a0 + 1] += w0 * (lD * gdy0 + lH * ghy0); pos[a0 + 2] += w0 * (lD * gdz0 + lH * ghz0);
      pos[a1] += w1 * (lD * gdx1 + lH * ghx1); pos[a1 + 1] += w1 * (lD * gdy1 + lH * ghy1); pos[a1 + 2] += w1 * (lD * gdz1 + lH * ghz1);
      pos[a2] += w2 * (lD * gdx2 + lH * ghx2); pos[a2 + 1] += w2 * (lD * gdy2 + lH * ghy2); pos[a2 + 2] += w2 * (lD * gdz2 + lH * ghz2);
      pos[a3] += w3 * (lD * gdx3 + lH * ghx3); pos[a3 + 1] += w3 * (lD * gdy3 + lH * ghy3); pos[a3 + 2] += w3 * (lD * gdz3 + lH * ghz3);
    }
    if (plastic && plastic.recover) {
      const rc = plastic.recover, ph = (this._ph = ((this._ph || 0) + 1) % 4);
      for (let t = ph; t < NT; t += 4) {
        const o = t * 9; let moved = false;
        for (let q = 0; q < 9; q++) { const dv = this.dm0[o + q] - dm[o + q]; if (dv !== 0) { dm[o + q] += dv * rc * 4; moved = true; } }
        if (moved) {
          const n0 = dm[o], n1 = dm[o + 1], n2 = dm[o + 2], n3 = dm[o + 3], n4 = dm[o + 4], n5 = dm[o + 5], n6 = dm[o + 6], n7 = dm[o + 7], n8 = dm[o + 8];
          const dt0 = n0 * (n4 * n8 - n5 * n7) + n1 * (n5 * n6 - n3 * n8) + n2 * (n3 * n7 - n4 * n6);
          minv[o] = (n4 * n8 - n5 * n7) / dt0; minv[o + 1] = (n2 * n7 - n1 * n8) / dt0; minv[o + 2] = (n1 * n5 - n2 * n4) / dt0;
          minv[o + 3] = (n5 * n6 - n3 * n8) / dt0; minv[o + 4] = (n0 * n8 - n2 * n6) / dt0; minv[o + 5] = (n2 * n3 - n0 * n5) / dt0;
          minv[o + 6] = (n3 * n7 - n4 * n6) / dt0; minv[o + 7] = (n1 * n6 - n0 * n7) / dt0; minv[o + 8] = (n0 * n4 - n1 * n3) / dt0;
        }
      }
    }
    this.volRatio = vol / this.restVol; this.strain = strainAcc / Math.max(1, this.nFlesh);
    if (grabbed) this.applyGrabs(0.3);
    this.contacts(h);
    const wl = this.wall;
    for (let i = 0; i < N; i++) {
      const k = i * 3;
      if (pos[k] > wl) pos[k] = wl; else if (pos[k] < -wl) pos[k] = -wl;
      if (pos[k + 2] > wl) pos[k + 2] = wl; else if (pos[k + 2] < -wl) pos[k + 2] = -wl;
    }
    for (let i = 0; i < N * 3; i++) vel[i] = (pos[i] - prev[i]) / h;
    if (this.tether) {
      // Stickiness. The bottom layer of nodes remembers where it last rested (state 1 = glued). When something pulls the
      // body up, the nodes nearest the pull peel first (their threshold is lower), so the dough comes off the plate from the
      // pulled side and the far side lets go last. A peeled node stays attached by a weak thread (state 2) before it is free.
      const T = this.tether, an = this.anchor, lt = this.latched, grabbed = this.grabs.size > 0;
      let gx = 0, gz = 0, gn = 0; if (grabbed) for (const g of this.grabs.values()) { gx += g.hit[0]; gz += g.hit[2]; gn++; } if (gn) { gx /= gn; gz /= gn; }
      for (const i of this.tnodes) {
        const k = i * 3;
        if (!grabbed) { if (lt[i] !== 1 && pos[k + 1] < this.floorY + 0.05 + 0.5 * this.L.c && Math.hypot(vel[k], vel[k + 1], vel[k + 2]) < 0.6) { an[k] = pos[k]; an[k + 1] = pos[k + 1]; an[k + 2] = pos[k + 2]; lt[i] = 1; } continue; }
        if (!lt[i]) continue;
        const dx = an[k] - pos[k], dy = an[k + 1] - pos[k + 1], dz = an[k + 2] - pos[k + 2], d = Math.hypot(dx, dy, dz);
        const near = Math.min(1, Math.hypot(an[k] - gx, an[k + 2] - gz) / 1.1), thr = T.len * (0.5 + 0.5 * near);
        if (lt[i] === 1) {
          if (d > thr) { lt[i] = 2; this.snaps++; } else { pos[k] += dx * T.k; pos[k + 1] += dy * T.k; pos[k + 2] += dz * T.k; vel[k] *= 0.9; vel[k + 1] *= 0.9; vel[k + 2] *= 0.9; }
        } else {
          if (d > thr * (T.thread || 2.4)) { lt[i] = 0; this.snaps++; } else { const w = T.k * 0.35; pos[k] += dx * w; pos[k + 1] += dy * w; pos[k + 2] += dz * w; }
        }
      }
    }
    if (this.adhesion > 0) { const fy = this.floorY + 0.06, ad = 1 - this.adhesion; for (let i = 0; i < N; i++) if (pos[i * 3 + 1] < fy && vel[i * 3 + 1] > 0) vel[i * 3 + 1] *= ad; }
    if (this.touching) this.restingDrag();
  }
  // While the fruit sits on the floor, bleed off part of its overall rolling and sliding (the rigid part of its motion)
  // so a nudge does not send a round-bottomed half fruit skating away. Internal wobble is left alone.
  restingDrag() {
    const { pos, vel, N } = this, rollK = (this.grabs.size ? 0.06 : 0.14) * this.dragScale, slideK = (this.grabs.size ? 0 : 0.16) * this.dragScale;
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < N; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; vx += vel[i * 3]; vy += vel[i * 3 + 1]; vz += vel[i * 3 + 2]; }
    cx /= N; cy /= N; cz /= N; vx /= N; vy /= N; vz /= N;
    let Lx = 0, Ly = 0, Lz = 0, I = 1e-9;
    for (let i = 0; i < N; i++) {
      const rx = pos[i * 3] - cx, ry = pos[i * 3 + 1] - cy, rz = pos[i * 3 + 2] - cz, ux = vel[i * 3] - vx, uy = vel[i * 3 + 1] - vy, uz = vel[i * 3 + 2] - vz;
      Lx += ry * uz - rz * uy; Ly += rz * ux - rx * uz; Lz += rx * uy - ry * ux; I += rx * rx + ry * ry + rz * rz;
    }
    const wx = Lx / I * 1.6, wy = Ly / I * 1.6, wz = Lz / I * 1.6;          // ~ angular velocity (isotropic inertia, rough)
    for (let i = 0; i < N; i++) {
      const rx = pos[i * 3] - cx, ry = pos[i * 3 + 1] - cy, rz = pos[i * 3 + 2] - cz;
      vel[i * 3] -= rollK * (wy * rz - wz * ry) + slideK * vx; vel[i * 3 + 1] -= rollK * (wz * rx - wx * rz);
      vel[i * 3 + 2] -= rollK * (wx * ry - wy * rx) + slideK * vz;
    }
  }
  // the floor, tested at points on the visible surface (not at lattice nodes) so the skin touches it exactly
  contacts(h) {
    const { pos, prev, invMass } = this, C = this.L.contact, ids = C.ids, loc = C.loc;
    this.touching = false;
    const fa = this._fa || (this._fa = new Float32Array(this.N * 2)), fw = this._fw || (this._fw = new Float32Array(this.N)), touched = this._tc || (this._tc = new Uint8Array(this.N)), list = [];
    for (let p = 0; p < C.n; p++) {
      const tx = loc[p * 3], ty = loc[p * 3 + 1], tz = loc[p * 3 + 2];
      let py = 0, ppy = 0, px = 0, pz = 0, ppx = 0, ppz = 0, den = 0, vy = 0;
      const wts = this._w || (this._w = new Float32Array(8));
      for (let k = 0; k < 8; k++) {
        const w = ((k & 1) ? tx : 1 - tx) * ((k & 2) ? ty : 1 - ty) * ((k & 4) ? tz : 1 - tz), id = ids[p * 8 + k] * 3;
        wts[k] = w; vy += w * this.vel[id + 1]; py += w * pos[id + 1]; ppy += w * prev[id + 1]; px += w * pos[id]; ppx += w * prev[id]; pz += w * pos[id + 2]; ppz += w * prev[id + 2];
        den += w * w * invMass[ids[p * 8 + k]];
      }
      if (py >= this.floorY + 0.01 || den < 1e-12) continue;
      this.touching = true;
      if (py >= this.floorY) continue;
      const pen = this.floorY - py, sp = -vy;                      // how fast the surface was falling when it met the floor
      if (sp > this.impact) this.impact = sp;
      const fx = (px - ppx) * this.friction, fz = (pz - ppz) * this.friction;        // friction: kill most of the sideways slip
      for (let k = 0; k < 8; k++) {
        const id = ids[p * 8 + k], s = wts[k] * invMass[id] / den;
        pos[id * 3 + 1] += pen * s;
        // friction is gathered per node and averaged, so a node shared by many contact points is never pushed back
        // further than it actually slid
        fa[id * 2] += wts[k] * fx; fa[id * 2 + 1] += wts[k] * fz; fw[id] += wts[k];
        if (!touched[id]) { touched[id] = 1; list.push(id); }
      }
    }
    for (const id of list) { const w = fw[id], k = w > 1e-9 ? Math.min(1, w) / w : 0; pos[id * 3] -= fa[id * 2] * k; pos[id * 3 + 2] -= fa[id * 2 + 1] * k; fa[id * 2] = fa[id * 2 + 1] = 0; fw[id] = 0; touched[id] = 0; }
  }
  // breathing-mode metric: mean distance of nodes to their centroid, relative to rest (rotation invariant)
  gyration() {
    const { pos, N, rest } = this;
    let cx = 0, cy = 0, cz = 0, rx = 0, ry = 0, rz = 0;
    for (let i = 0; i < N; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; rx += rest[i * 3]; ry += rest[i * 3 + 1]; rz += rest[i * 3 + 2]; }
    cx /= N; cy /= N; cz /= N; rx /= N; ry /= N; rz /= N;
    let a = 0, b = 0;
    for (let i = 0; i < N; i++) { a += Math.hypot(pos[i * 3] - cx, pos[i * 3 + 1] - cy, pos[i * 3 + 2] - cz); b += Math.hypot(rest[i * 3] - rx, rest[i * 3 + 1] - ry, rest[i * 3 + 2] - rz); }
    return a / b - 1;
  }
  // current positions of a bound point set
  sample(S, out) {
    const { pos } = this, ids = S.ids, loc = S.loc;
    for (let p = 0; p < S.n; p++) {
      const tx = loc[p * 3], ty = loc[p * 3 + 1], tz = loc[p * 3 + 2];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 8; k++) { const w = ((k & 1) ? tx : 1 - tx) * ((k & 2) ? ty : 1 - ty) * ((k & 4) ? tz : 1 - tz), id = ids[p * 8 + k] * 3; x += w * pos[id]; y += w * pos[id + 1]; z += w * pos[id + 2]; }
      out[p * 3] = x; out[p * 3 + 1] = y; out[p * 3 + 2] = z;
    }
    return out;
  }
}
