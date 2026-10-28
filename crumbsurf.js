// A continuous surface for the crumb particles (naive surface nets on a density field, rebuilt every frame). Each particle
// adds a smooth bump of density; where the cake is whole the bumps merge into one body, where it tore the surface follows the
// ragged edge. Every vertex also carries the weighted rest position of the particles around it, so the sponge texture sticks.
export class CrumbSurface {
  constructor(s, maxVerts = 120000) {
    this.h = s * 0.62; this.R = s * 1.22; this.iso = 0.32;
    this.maxV = maxVerts;
    this.pos = new Float32Array(maxVerts * 3); this.nrm = new Float32Array(maxVerts * 3); this.rest = new Float32Array(maxVerts * 3);
    this.idx = new Uint32Array(maxVerts * 6); this.nv = 0; this.ni = 0;
    this.cap = 0;
  }
  ensure(n) { if (n <= this.cap) return; this.cap = Math.ceil(n * 1.3); this.F = new Float32Array(this.cap); this.RX = new Float32Array(this.cap * 3); this.vid = new Int32Array(this.cap); }
  build(P, rest, use, N) {
    const R = this.R, R2 = R * R;
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], cnt = 0;
    for (let i = 0; i < N; i++) { if (!use[i]) continue; cnt++; for (let a = 0; a < 3; a++) { const v = P[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; } }
    if (!cnt) { this.nv = this.ni = 0; return; }
    let h = this.h;
    const ext = [hi[0] - lo[0] + 2 * R + 2 * h, hi[1] - lo[1] + 2 * R + 2 * h, hi[2] - lo[2] + 2 * R + 2 * h];
    while (Math.ceil(ext[0] / h) * Math.ceil(ext[1] / h) * Math.ceil(ext[2] / h) > 400000) h *= 1.15;     // a spread-out mess gets a coarser grid
    const nx = Math.ceil(ext[0] / h) + 1, ny = Math.ceil(ext[1] / h) + 1, nz = Math.ceil(ext[2] / h) + 1, ox = lo[0] - R - h, oy = lo[1] - R - h, oz = lo[2] - R - h;
    const M = nx * ny * nz; this.ensure(M); this.M = M; const F = this.F, RX = this.RX; F.fill(0, 0, M); RX.fill(0, 0, M * 3);
    const r = Math.ceil(R / h), sxy = nx * ny;
    // splat: (1 - d^2/R^2)^3
    for (let i = 0; i < N; i++) {
      if (!use[i]) continue;
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2], gx = Math.round((px - ox) / h), gy = Math.round((py - oy) / h), gz = Math.round((pz - oz) / h);
      const rx = rest[i * 3] - px, ry = rest[i * 3 + 1] - py, rz = rest[i * 3 + 2] - pz;          // how far this particle has moved from its rest place
      for (let z = Math.max(0, gz - r); z <= Math.min(nz - 1, gz + r); z++) { const dz = oz + z * h - pz, dz2 = dz * dz;
        for (let y = Math.max(0, gy - r); y <= Math.min(ny - 1, gy + r); y++) { const dy = oy + y * h - py, dyz = dy * dy + dz2; if (dyz >= R2) continue;
          let o = z * sxy + y * nx + Math.max(0, gx - r);
          for (let x = Math.max(0, gx - r); x <= Math.min(nx - 1, gx + r); x++, o++) { const dx = ox + x * h - px, d2 = dx * dx + dyz; if (d2 >= R2) continue;
            const t = 1 - d2 / R2, w = t * t * t; F[o] += w; RX[o * 3] += w * rx; RX[o * 3 + 1] += w * ry; RX[o * 3 + 2] += w * rz; } } }
    }
    // surface nets: one vertex per cell the surface passes through, at the mean of its edge crossings
    const iso = this.iso, vid = this.vid, pos = this.pos, nrm = this.nrm, rs = this.rest, idx = this.idx, maxV = this.maxV;
    let nv = 0, ni = 0; vid.fill(-1, 0, M);
    const EF = EDGES;
    const co = [0, 1, nx, nx + 1, sxy, sxy + 1, sxy + nx, sxy + nx + 1], cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1];
    const v = new Float32Array(8);
    for (let z = 0; z < nz - 1 && nv < maxV; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
      const o = z * sxy + y * nx + x;
      const f0 = F[o], f1 = F[o + 1], f2 = F[o + nx], f3 = F[o + nx + 1], f4 = F[o + sxy], f5 = F[o + sxy + 1], f6 = F[o + sxy + nx], f7 = F[o + sxy + nx + 1];
      if (f0 < iso && f1 < iso && f2 < iso && f3 < iso && f4 < iso && f5 < iso && f6 < iso && f7 < iso) continue;
      if (f0 > iso && f1 > iso && f2 > iso && f3 > iso && f4 > iso && f5 > iso && f6 > iso && f7 > iso) continue;
      v[0] = f0 - iso; v[1] = f1 - iso; v[2] = f2 - iso; v[3] = f3 - iso; v[4] = f4 - iso; v[5] = f5 - iso; v[6] = f6 - iso; v[7] = f7 - iso;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let e = 0; e < 24; e += 2) { const a = EF[e], b = EF[e + 1]; if ((v[a] > 0) === (v[b] > 0)) continue; const t = v[a] / (v[a] - v[b]); sx += cx[a] + (cx[b] - cx[a]) * t; sy += cy[a] + (cy[b] - cy[a]) * t; sz += cz[a] + (cz[b] - cz[a]) * t; n++; }
      sx /= n; sy /= n; sz /= n;
      const q = nv * 3; pos[q] = ox + (x + sx) * h; pos[q + 1] = oy + (y + sy) * h; pos[q + 2] = oz + (z + sz) * h;
      // gradient of the trilinear field (pointing out of the cake) and the rest position, interpolated the same way
      const gx = (v[1] - v[0]) * (1 - sy) * (1 - sz) + (v[3] - v[2]) * sy * (1 - sz) + (v[5] - v[4]) * (1 - sy) * sz + (v[7] - v[6]) * sy * sz;
      const gy = (v[2] - v[0]) * (1 - sx) * (1 - sz) + (v[3] - v[1]) * sx * (1 - sz) + (v[6] - v[4]) * (1 - sx) * sz + (v[7] - v[5]) * sx * sz;
      const gz = (v[4] - v[0]) * (1 - sx) * (1 - sy) + (v[5] - v[1]) * sx * (1 - sy) + (v[6] - v[2]) * (1 - sx) * sy + (v[7] - v[3]) * sx * sy;
      const gl = Math.hypot(gx, gy, gz) || 1; nrm[q] = -gx / gl; nrm[q + 1] = -gy / gl; nrm[q + 2] = -gz / gl;
      let wr = 0, ax = 0, ay = 0, az = 0;
      for (let k = 0; k < 8; k++) { const c = o + co[k], w = F[c] + 1e-6; wr += w; ax += RX[c * 3]; ay += RX[c * 3 + 1]; az += RX[c * 3 + 2]; }
      rs[q] = pos[q] + ax / wr; rs[q + 1] = pos[q + 1] + ay / wr; rs[q + 2] = pos[q + 2] + az / wr;   // the vertex carried back by the local displacement
      vid[o] = nv++;
      // a quad for each of the three edges leaving the lowest corner that the surface crosses
      if (x > 0 && y > 0 && z > 0) {
        const s0 = v[0] > 0;
        if (s0 !== (v[1] > 0)) { const a = vid[o], b = vid[o - nx], c = vid[o - nx - sxy], d = vid[o - sxy]; if (b >= 0 && c >= 0 && d >= 0) ni = quad(idx, ni, s0, a, b, c, d); }
        if (s0 !== (v[2] > 0)) { const a = vid[o], b = vid[o - sxy], c = vid[o - 1 - sxy], d = vid[o - 1]; if (b >= 0 && c >= 0 && d >= 0) ni = quad(idx, ni, s0, a, b, c, d); }
        if (s0 !== (v[4] > 0)) { const a = vid[o], b = vid[o - 1], c = vid[o - 1 - nx], d = vid[o - nx]; if (b >= 0 && c >= 0 && d >= 0) ni = quad(idx, ni, s0, a, b, c, d); }
      }
    }
    this.nv = nv; this.ni = ni;
  }
}
const EDGES = new Int8Array([0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7]);
function quad(idx, ni, flip, a, b, c, d) {
  if (flip) { idx[ni++] = a; idx[ni++] = b; idx[ni++] = c; idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; }
  else { idx[ni++] = a; idx[ni++] = c; idx[ni++] = b; idx[ni++] = a; idx[ni++] = d; idx[ni++] = c; }
  return ni;
}
