// GPU skinning plus one fragment recipe per thing. Surface vertices ride the lattice (trilinear), normals follow the
// local deformation, and every look is procedural, driven by the vertex's rest position so it sticks to the material.
export const SKIN_HEAD = `
attribute vec4 aNodesA; attribute vec4 aNodesB; attribute vec3 aLocal; attribute float aGlow; attribute float aRegion;
uniform sampler2D uNodes;
varying vec3 vRest; varying float vRegion; varying float vGlow; varying vec3 vRestN; varying vec3 vTx; varying vec3 vTz; varying float vDmg;
float gDmg; vec3 gSkinP; vec3 gSf1; vec3 gSf2; vec3 gSf3;
vec4 nodeAt4(float id) { int i = int(id + 0.5); return texelFetch(uNodes, ivec2(i & 1023, i >> 10), 0); }
vec3 nodeAt(float id) { return nodeAt4(id).xyz; }
void skinNodes() {
  vec3 p0 = nodeAt(aNodesA.x), p1 = nodeAt(aNodesA.y), p2 = nodeAt(aNodesA.z), p3 = nodeAt(aNodesA.w);
  vec3 p4 = nodeAt(aNodesB.x), p5 = nodeAt(aNodesB.y), p6 = nodeAt(aNodesB.z), p7 = nodeAt(aNodesB.w);
  float tx = aLocal.x, ty = aLocal.y, tz = aLocal.z, ux = 1.0 - tx, uy = 1.0 - ty, uz = 1.0 - tz;
  gDmg = ux*uy*uz*nodeAt4(aNodesA.x).w + tx*uy*uz*nodeAt4(aNodesA.y).w + ux*ty*uz*nodeAt4(aNodesA.z).w + tx*ty*uz*nodeAt4(aNodesA.w).w + ux*uy*tz*nodeAt4(aNodesB.x).w + tx*uy*tz*nodeAt4(aNodesB.y).w + ux*ty*tz*nodeAt4(aNodesB.z).w + tx*ty*tz*nodeAt4(aNodesB.w).w;
  gSkinP = ux*uy*uz*p0 + tx*uy*uz*p1 + ux*ty*uz*p2 + tx*ty*uz*p3 + ux*uy*tz*p4 + tx*uy*tz*p5 + ux*ty*tz*p6 + tx*ty*tz*p7;
  gSf1 = uy*uz*(p1-p0) + ty*uz*(p3-p2) + uy*tz*(p5-p4) + ty*tz*(p7-p6);
  gSf2 = ux*uz*(p2-p0) + tx*uz*(p3-p1) + ux*tz*(p6-p4) + tx*tz*(p7-p5);
  gSf3 = ux*uy*(p4-p0) + tx*uy*(p5-p1) + ux*ty*(p6-p2) + tx*ty*(p7-p3);
}`;
export const FRAG_HEAD = `
varying vec3 vRest; varying float vRegion; varying float vGlow; varying vec3 vRestN; varying vec3 vTx; varying vec3 vTz; varying float vDmg;
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 h33(vec3 p) { p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// 3D cellular noise: x = distance to the nearest cell centre, y = to the second nearest, z = a hash of the nearest cell
vec3 vor3(vec3 p) {
  vec3 ip = floor(p), fp = fract(p); float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 g = vec3(float(i), float(j), float(k)); vec3 o = h33(ip + g); float d = length(g + o - fp);
    if (d < d1) { d2 = d1; d1 = d; id = h31(ip + g + 3.7); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
vec3 perturbN(vec3 pos, vec3 n, vec2 dH) {
  vec3 sx = normalize(dFdx(pos)), sy = normalize(dFdy(pos)), r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * (float(gl_FrontFacing) * 2.0 - 1.0);
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`;

// ---- watermelon: wavy rind stripes, pale layer, granular red flesh with seeds ----
export const WATERMELON = {
  uniforms: { uStripeA: null, uStripeB: null, uSeeds: null },
  decl: `uniform vec3 uStripeA; uniform vec3 uStripeB; uniform float uSeeds;
float seedField(vec2 p, out float dimple) {
  vec2 cell = floor(p / 0.3); float m = 0.0; dimple = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j)); if (h21(c) > 0.46) continue;
    vec2 center = (c + 0.2 + 0.6 * vec2(h21(c + 7.1), h21(c + 3.3))) * 0.3, d = p - center; float ang = h21(c + 11.0) * 6.2832;
    d = vec2(cos(ang) * d.x + sin(ang) * d.y, -sin(ang) * d.x + cos(ang) * d.y); d.x += 0.012 * (d.y / 0.03) * (d.y / 0.03);
    float e = length(d / vec2(0.07, 0.036)); m = max(m, 1.0 - smoothstep(0.82, 1.02, e)); dimple = max(dimple, 1.0 - smoothstep(0.0, 1.7, e));
  }
  return m;
}`,
  color: `
    float up = smoothstep(0.3, 0.7, vRestN.y), flesh = (1.0 - smoothstep(-0.03, 0.0, vGlow)) * up;
    float th = atan(vRest.z, vRest.y);
    float w = th * 13.0 + 2.6 * sin(vRest.x * 2.3 + vn(vRest * 2.0) * 3.0) + 3.2 * (vn(vRest * 3.5) - 0.5);
    float st = smoothstep(0.32, 0.68, 0.5 + 0.5 * sin(w));
    vec3 rindC = mix(uStripeA, uStripeB, st);
    rindC = mix(rindC, rindC * vec3(1.15, 1.1, 0.9), smoothstep(0.55, 0.9, vn(vRest * 9.0)) * 0.5) * (0.92 + 0.16 * vn(vRest * 40.0));
    vec3 faceC = diffuseColor.rgb * (0.95 + 0.1 * vn(vRest * 85.0));
    float dimple; float sm = seedField(vRest.xz, dimple); float ok = step(vGlow, -0.07) * uSeeds;
    float g = vn(vRest * 75.0) * 0.55 + vn(vRest * 190.0) * 0.45;
    vec3 fleshC = mix(diffuseColor.rgb * (0.9 + 0.2 * g), vec3(0.045, 0.028, 0.022), sm * ok);
    diffuseColor.rgb = mix(rindC, mix(faceC, fleshC, flesh), up);`,
  rough: `roughnessFactor = mix(0.38, mix(0.78, 0.24, flesh), up);`,
  normal: `if (flesh > 0.5) { float d2; float s2 = seedField(vRest.xz, d2); float ok2 = step(vGlow, -0.07) * uSeeds;
    float hh = (vn(vRest * 75.0) * 0.55 + vn(vRest * 190.0) * 0.45) * 0.0035 - d2 * ok2 * 0.006 + s2 * ok2 * 0.0035;
    normal = perturbN(-vViewPosition, normal, vec2(dFdx(hh), dFdy(hh)) * 260.0); }`,
  emissive: `totalEmissiveRadiance += diffuseColor.rgb * flesh * 0.03;`,
  clearcoat: `material.clearcoat *= mix(0.35, flesh, up);`,
};

// ---- red jelly: a moulded gelatin dessert, glossy and see-through ----
export const JELLY = {
  uniforms: { uBase: null, uDeep: null },
  decl: `uniform vec3 uBase; uniform vec3 uDeep;`,
  color: `
    float flute = mix(0.75, 0.5 + 0.5 * cos(8.0 * atan(vRest.z, vRest.x)), 1.0 - smoothstep(0.55, 0.85, vRestN.y));   // no rays on the flat top
    float streak = vn(vec3(vRest.x * 5.0, vRest.y * 1.3, vRest.z * 5.0)) * 0.6 + vn(vec3(vRest.x * 12.0, vRest.y * 2.5, vRest.z * 12.0)) * 0.4;
    diffuseColor.rgb = mix(uDeep, uBase, 0.35 + 0.5 * streak) * (0.55 + 0.5 * flute);`,
  rough: `roughnessFactor = 0.05;`,
  normal: ``,
  // light passes through the gel: the middle of the silhouette glows, the thin grazing edges go deep and bright at the rim
  emissive: `float nv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
    float thru = pow(nv, 1.2), rimL = pow(1.0 - nv, 3.0);
    totalEmissiveRadiance += mix(uDeep, uBase, thru) * (0.1 + 0.4 * flute * (0.5 + 0.5 * streak) * (0.5 + 0.5 * thru)) + vec3(1.0, 0.3, 0.3) * rimL * 0.18;`,
  clearcoat: `material.clearcoat = 1.0; material.clearcoatRoughness = 0.03;`,
};

// ---- mochi: soft white rice dough with a glossy, slightly sticky skin; the bean paste is matte, dusty and sandy ----
export const MOCHI = {
  uniforms: { uDough: null, uBean: null },
  decl: `uniform vec3 uDough; uniform vec3 uBean;`,
  color: `
    float kk = length(vec3(vRest.x / 0.8, (vRest.y - 0.03) / 0.44, vRest.z / 0.8));
    float pasteM = 1.0 - smoothstep(0.97, 1.05, kk);                                                   // inside the core = bean paste
    float grain = vn(vRest * 64.0) * 0.45 + vn(vRest * 105.0) * 0.35 + vn(vRest * 30.0) * 0.2;       // sandy, coarse-ground paste
    float bit = smoothstep(0.72, 0.9, vn(vRest * 80.0 + 7.0)), pale = smoothstep(0.74, 0.92, vn(vRest * 58.0 + 3.0));
    vec3 pasteC = uBean * (0.62 + 0.7 * grain) * (1.0 - 0.35 * bit) + vec3(0.12, 0.06, 0.05) * pale;  // matte, with dark and pale grains
    float thin = 1.0 - smoothstep(1.05, 1.5, kk);                                                      // dough close to the paste is thin and shows a little red
    vec3 doughC = mix(uDough, uBean * 1.7 + vec3(0.25), 0.18 * thin) * (0.97 + 0.05 * vn(vRest * 30.0));
    diffuseColor.rgb = mix(doughC, pasteC, pasteM);`,
  rough: `roughnessFactor = mix(0.34, 0.95, pasteM);`,
  normal: `float hb = (1.0 - pasteM) * (vn(vRest * 13.0) - 0.5) * 0.006 + pasteM * (grain * 0.012 + bit * 0.004);
    normal = perturbN(-vViewPosition, normal, vec2(dFdx(hb), dFdy(hb)) * 260.0);`,
  emissive: `totalEmissiveRadiance += diffuseColor.rgb * mix(0.1, 0.03, pasteM);`,
  clearcoat: `material.clearcoat *= mix(0.55, 0.0, pasteM); material.clearcoatRoughness = 0.3;`,
};

// ---- bubble block: a slab with a grid of air bubbles on top; popped ones collapse ----
export const BUBBLE = {
  uniforms: { uTint: null, uBub: null, uGrid: null, uBR: null, uDim: null, uStk: null, uOff: null },
  vertDecl: `uniform sampler2D uBub; uniform vec4 uGrid; uniform vec2 uBR; uniform vec2 uDim; uniform vec2 uStk; uniform vec3 uOff[6];`,
  bubbleFn: `
float bubbleAt(vec2 p, out vec2 id, out float valid) {
  float rowf = floor((p.y - uGrid.y) / uGrid.w + 0.5), best = 1e9; id = vec2(0.0); valid = 0.0;
  for (int dr = -1; dr <= 1; dr++) {
    float r = rowf + float(dr), xo = mod(r, 2.0) * 0.5 * uGrid.z, c = floor((p.x - uGrid.x - xo) / uGrid.z + 0.5);
    vec2 ctr = vec2(uGrid.x + xo + c * uGrid.z, uGrid.y + r * uGrid.w); float d = length(p - ctr);
    if (d < best) { best = d; id = vec2(c, r); }
  }
  valid = step(0.0, id.x) * step(id.x, uDim.x - 0.5) * step(0.0, id.y) * step(id.y, uDim.y - 0.5);
  return best;
}
// each sheet is its own film with its own grid (shifted by uOff[l]); state is packed 4 sheets per texel (x+32 for sheets 4-5)
float sheetState(vec2 id, int l) {
  vec4 t = texelFetch(uBub, ivec2(clamp(int(id.x), 0, 31) + (l >= 4 ? 32 : 0), clamp(int(id.y), 0, 31)), 0);
  int c = l >= 4 ? l - 4 : l; return c == 0 ? t.r : c == 1 ? t.g : c == 2 ? t.b : t.a;
}
vec2 sheetLocal(vec2 p, int l) { vec3 o = uOff[l]; vec2 q = p - o.xy; float c = cos(o.z), s = sin(o.z); return vec2(c * q.x + s * q.y, -s * q.x + c * q.y); }   // into the sheet's own frame
float sheetHeight(vec2 p, int l) {
  vec2 id; float valid; float d = bubbleAt(sheetLocal(p, l), id, valid); float u = d / uBR.x, s = sheetState(id, l);
  float dome = pow(max(0.0, 1.0 - u * u), 0.7) * uBR.y, crumple = max(0.0, 1.0 - u * u) * 0.006;
  return max(crumple, dome * s) * valid;
}`,
  vertAfter: `{ int sl = int(aRegion + 0.5); float topW = step(0.5, normal.y); transformed += objectNormal * sheetHeight(position.xz, sl) * topW; }`,
  decl: `uniform vec3 uTint; uniform sampler2D uBub; uniform vec4 uGrid; uniform vec2 uBR; uniform vec2 uDim; uniform vec2 uStk; uniform vec3 uOff[6];`,
  // thin clear film: low alpha; blister rims, heat-sealed seams and the cut edge of each sheet catch the light, popped film is a cloudy crumple
  color: `
    int sl = int(vRegion + 0.5); float topW = step(0.5, vRestN.y), edgeW = 1.0 - step(0.5, abs(vRestN.y));
    vec2 bid; float bvalid; float bd = bubbleAt(sheetLocal(vRest.xz, sl), bid, bvalid); float s = sheetState(bid, sl);
    float bu = bd / uBR.x, inB = (1.0 - smoothstep(0.88, 1.0, bu)) * bvalid * topW;
    float seam = smoothstep(0.95, 1.05, bu) * (1.0 - smoothstep(1.05, 1.3, bu)) * bvalid * topW;
    float ring = (1.0 - smoothstep(0.0, 0.05, abs(bu - 0.8))) * inB * s;
    float rid = 1.0 - abs(vn(vRest * 17.0 + bid.x * 3.1 + float(sl)) * 2.0 - 1.0), rid2 = 1.0 - abs(vn(vRest * 31.0 + bid.y * 5.3) * 2.0 - 1.0);
    float crinkle = smoothstep(0.7, 0.97, rid * 0.7 + rid2 * 0.3) * (1.0 - s) * inB;
    float bstate = s;
    float alpha = 0.06 + 0.05 * ring + 0.12 * seam + inB * s * 0.07 * smoothstep(0.5, 1.0, bu) + inB * (1.0 - s) * (0.18 + 0.25 * crinkle) + edgeW * 0.55;
    diffuseColor.rgb = uTint * (0.9 + 0.1 * vn(vRest * 60.0)) * (1.0 - 0.15 * edgeW);
    diffuseColor.a = min(alpha, 0.7);`,
  rough: `roughnessFactor = mix(0.06, 0.32, (1.0 - bstate) * inB);`,
  normal: `if (topW > 0.5) { float e = 0.006; vec2 pq = vRest.xz;
      float hx = (sheetHeight(pq + vec2(e, 0.0), sl) - sheetHeight(pq - vec2(e, 0.0), sl)) / (2.0 * e);
      float hz = (sheetHeight(pq + vec2(0.0, e), sl) - sheetHeight(pq - vec2(0.0, e), sl)) / (2.0 * e);
      vec3 nn = normalize(normal - hx * normalize(vTx) - hz * normalize(vTz)); if (length(nn) > 0.5) normal = nn; }`,
  emissive: `float bf = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.0);
    diffuseColor.a = clamp(diffuseColor.a + bf * 0.2 * (0.4 + 0.6 * inB * bstate) + 0.1 * seam, 0.0, 1.0);
    totalEmissiveRadiance += vec3(0.8, 0.9, 1.0) * bf * 0.1 * (inB * bstate + 0.3);`,
  clearcoat: `material.clearcoat = 1.0; material.clearcoatRoughness = 0.09;`,
};

// ---- crisp chocolate shell over white cream: the shell stays glossy chocolate; cracks open only along a few big fracture lines ----
export const CHOC = {
  uniforms: { uShell: null },
  decl: `uniform vec3 uShell;`,
  color: `
    float topF = smoothstep(0.1, 0.6, vRestN.y);
    vec3 vc = vor3(vRest * 2.1); float edge = vc.y - vc.x;                                         // big plates
    float open = smoothstep(0.35, 0.9, vDmg);
    float line = 1.0 - smoothstep(0.0, 0.035 + 0.11 * open, edge);                                   // the fracture line, wider where it has opened
    float hair = (1.0 - smoothstep(0.0, 0.018, edge)) * smoothstep(0.15, 0.5, vDmg);
    float showCream = line * smoothstep(0.35, 0.65, vDmg);
    vec3 nibc = vor3(vRest * 9.0 + 3.0); float nib = (1.0 - smoothstep(0.1, 0.2, nibc.x)) * step(0.62, nibc.z) * topF;
    float spk = step(0.96, h31(floor(vRest * 90.0)));
    vec3 choc = uShell * (0.85 + 0.3 * vn(vRest * 14.0)) * (1.0 - 0.6 * hair);
    choc = mix(choc, vec3(0.28, 0.16, 0.09) * (0.8 + 0.5 * vn(vRest * 50.0)), nib * 0.85);
    choc += vec3(0.04) * spk;
    vec3 cream = vec3(0.94, 0.93, 0.89) * (0.9 + 0.12 * vn(vRest * 60.0));
    diffuseColor.rgb = mix(choc, cream, showCream);`,
  rough: `roughnessFactor = mix(0.2 + 0.25 * nib, 0.85, showCream);`,
  normal: `float hb = nib * 0.008 + (1.0 - showCream) * (vn(vRest * 18.0) - 0.5) * 0.003 - showCream * 0.01 - hair * 0.004;
    normal = perturbN(-vViewPosition, normal, vec2(dFdx(hb), dFdy(hb)) * 240.0);`,
  emissive: `totalEmissiveRadiance += diffuseColor.rgb * showCream * 0.05;`,
  clearcoat: `material.clearcoat *= (1.0 - showCream); material.clearcoatRoughness = 0.18;`,
};

// ---- sponge cake: pale yellow, dry and crumbly, with air pores and darker crumbs ----
export const CRUMB = {
  uniforms: {}, decl: ``,
  // torn sponge: open pores of every size (dark, shaded holes), lumpy cell walls between them, matte and dry
  color: `
    vec3 q1 = vor3(vRest * 15.0), q2 = vor3(vRest * 34.0 + 4.0), q3 = vor3(vRest * 70.0 + 9.0);
    float p1 = (1.0 - smoothstep(0.18, 0.42, q1.x)) * step(0.35, q1.z), p2 = (1.0 - smoothstep(0.15, 0.4, q2.x)) * step(0.25, q2.z), p3 = (1.0 - smoothstep(0.2, 0.45, q3.x)) * step(0.3, q3.z);
    float pore = max(p1, max(p2 * 0.85, p3 * 0.6));
    float wall = smoothstep(0.0, 0.25, q1.y - q1.x) * 0.5 + smoothstep(0.0, 0.2, q2.y - q2.x) * 0.5;
    float crev = pore * 0.8 + (1.0 - wall) * 0.15;
    vec3 sponge = mix(vec3(0.96, 0.77, 0.38), vec3(1.0, 0.88, 0.54), vn(vRest * 6.0) * 0.8 + 0.2 * q2.z);
    float speck = smoothstep(0.96, 0.985, q3.z) * (1.0 - pore) * 0.5;
    diffuseColor.rgb = mix(sponge * (1.0 - 0.55 * crev) * (0.93 + 0.1 * vn(vRest * 160.0)), vec3(0.68, 0.46, 0.2), speck);`,
  rough: `roughnessFactor = 1.0;`,
  normal: `float hb = -p1 * 0.03 - p2 * 0.016 - p3 * 0.007 + vn(vRest * 120.0) * 0.004; normal = perturbN(-vViewPosition, normal, vec2(dFdx(hb), dFdy(hb)) * 300.0);`,
  emissive: `totalEmissiveRadiance += diffuseColor.rgb * (0.04 + 0.06 * (1.0 - crev));`,
  clearcoat: `material.clearcoat = 0.0;`,
};

// ---- the chocolate slabs: dark glossy shell with nuts on the surface, and lighter brown fracture faces full of nut cross-sections ----
export const SLAB_VERT = `varying vec3 vRest; varying float vA1; varying float vA2; attribute float aA1; attribute float aA2; uniform vec3 uC; attribute float aE; attribute float aSlot; varying float vE; flat varying float vSlot;`;
export const SLAB_FRAG = `
uniform vec3 uShell; uniform float uOpen; varying float vA1; varying float vA2; uniform float uOpenN[12]; uniform float uSgnN[12]; varying float vE; flat varying float vSlot;
vec3 slabColor(vec3 p, float a1, float a2, out float nutAny, out float outerF, out float cutF) {
  outerF = 1.0 - smoothstep(0.3, 0.65, a1); float innerF = 1.0 - smoothstep(0.3, 0.65, a2); cutF = (1.0 - outerF) * (1.0 - innerF);
  // a crunchy coat: chopped nuts and crisp bits stuck all over it, angular, of mixed sizes, dipped in the same chocolate (a few show tan)
  vec3 g1 = vor3(p * 13.0), g2 = vor3(p * 29.0 + 3.0), g3 = vor3(p * 6.0 + 9.0);
  float e1 = g1.y - g1.x, e2 = g2.y - g2.x, e3 = g3.y - g3.x;
  float gr1 = smoothstep(0.6, 0.66, g1.z) * smoothstep(0.03, 0.2, e1) * (0.6 + 0.4 * h31(floor(p * 13.0) + g1.z));
  float gr2 = smoothstep(0.66, 0.72, g2.z) * smoothstep(0.03, 0.14, e2) * 0.55;
  float gr3 = smoothstep(0.8, 0.84, g3.z) * smoothstep(0.04, 0.25, e3) * 0.8;
  nutAny = clamp(max(max(gr1, gr2), gr3), 0.0, 1.0);
  float bare = smoothstep(0.975, 0.99, g1.z) * smoothstep(0.08, 0.2, e1) * 0.55 + smoothstep(0.985, 0.995, g2.z) * smoothstep(0.05, 0.12, e2) * 0.4;
  vec3 nutC = mix(vec3(0.3, 0.18, 0.09), vec3(0.45, 0.3, 0.16), vn(p * 40.0));
  vec3 choc = uShell * (0.8 + 0.3 * vn(p * 14.0)) * (1.0 + 0.3 * nutAny);
  vec3 outerC = mix(choc, nutC, clamp(bare, 0.0, 1.0));
  vec3 cutC = mix(uShell * 2.4 + vec3(0.05, 0.03, 0.02), nutC * 1.2, nutAny);
  vec3 innerC = uShell * 1.7 + vec3(0.03);
  cutC = mix(outerC, cutC, smoothstep(0.2, 0.7, uOpen));                           // while the shell is whole the joints look like plain chocolate
  return mix(mix(cutC, outerC, outerF), mix(outerC, innerC, smoothstep(0.2, 0.7, uOpen)), innerF * (1.0 - outerF) * 0.9);
}`;
