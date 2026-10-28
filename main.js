import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sim } from './sim.js';
import { SIM } from './simopts.js';
import { audio, initAudio, playSound, soundFrame, resetSoundState, pop, crunch, crack } from './audio.js';
import { SKIN_HEAD, FRAG_HEAD, WATERMELON, JELLY, MOCHI, BUBBLE, CRUMB, SLAB_VERT, SLAB_FRAG } from './shaders.js';
import { Pieces } from './pieces.js';
import { Crumb } from './crumb.js';
import { CrumbSurface } from './crumbsurf.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
const envTex = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTex; scene.environmentIntensity = 0.75;
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
const target = new THREE.Vector3(0, 0.45, 0);
const orbit = { theta: 0.5, phi: 1.1, r: 7.4, zoom: 1, fit: 7.4 };
function placeCamera() {
  const r = orbit.fit * orbit.zoom;
  camera.position.set(target.x + r * Math.sin(orbit.phi) * Math.sin(orbit.theta), target.y + r * Math.cos(orbit.phi), target.z + r * Math.sin(orbit.phi) * Math.cos(orbit.theta));
  camera.lookAt(target);
}
let item = null;
function resize() {
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h;
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  orbit.fit = Math.max(item ? item.cam.r : 7.4, (item ? item.cam.half : 1.95) / (t * Math.min(1, camera.aspect)));
  camera.updateProjectionMatrix(); placeCamera();
}
addEventListener('resize', resize);
const sun = new THREE.DirectionalLight(0xfff3e4, 2.6);
sun.position.set(-2.6, 6, 3.2); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 18 });
sun.shadow.radius = 9; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, new THREE.HemisphereLight(0xfff6ea, 0xb8b2a6, 0.55));
const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

// ---------- GPU skin material ----------
const nodeTex = new THREE.DataTexture(new Float32Array(1024 * 4 * 4), 1024, 4, THREE.RGBAFormat, THREE.FloatType);
nodeTex.minFilter = nodeTex.magFilter = THREE.NearestFilter; nodeTex.needsUpdate = true;
const U = {                                  // shared uniforms, filled in by each recipe
  uNodes: { value: nodeTex },
  uStripeA: { value: new THREE.Color(0x0f3d1b) }, uStripeB: { value: new THREE.Color(0x5aa043) }, uSeeds: { value: 1 },
  uBase: { value: new THREE.Color(0xe5142f) }, uDeep: { value: new THREE.Color(0x7a0716) },
  uDough: { value: new THREE.Color(0xf6f2ea) }, uBean: { value: new THREE.Color(0x5a1f1c) },
  uTint: { value: new THREE.Color(0xdff3ff) }, uShell: { value: new THREE.Color(0x1e120c) }, uBub: { value: null }, uGrid: { value: new THREE.Vector4() }, uBR: { value: new THREE.Vector2() }, uDim: { value: new THREE.Vector2() }, uCS: { value: 0.05 }, uStk: { value: new THREE.Vector2(0.016, 0.075) }, uOff: { value: Array.from({ length: 6 }, () => new THREE.Vector3()) },
};
function skinned(material, recipe, lit) {
  material.customProgramCacheKey = () => `${recipe.key}-${lit}`;      // the compile callback is identical for every item, so the cache key must say which recipe
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${SKIN_HEAD}\n${recipe.vertDecl || ''}\n${recipe.bubbleFn || ''}`);
    const set = 'vRest = position; vRegion = aRegion; vGlow = aGlow; vRestN = normal; vTx = normalize(normalMatrix * gSf1); vTz = normalize(normalMatrix * gSf3); vDmg = gDmg;';
    if (lit) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <beginnormal_vertex>', 'skinNodes(); vec3 objectNormal = normalize(cross(gSf2, gSf3) * normal.x + cross(gSf3, gSf1) * normal.y + cross(gSf1, gSf2) * normal.z);')
        .replace('#include <begin_vertex>', `vec3 transformed = gSkinP; ${set} ${recipe.vertAfter || ''}`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEAD}\n${recipe.decl || ''}\n${recipe.bubbleFn || ''}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${recipe.color}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${recipe.rough}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${recipe.normal}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${recipe.emissive}`)
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n${recipe.clearcoat}\n#endif`);
    } else {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `skinNodes(); vec3 transformed = gSkinP; ${set}`);
    }
  };
  return material;
}

// ---------- the four things ----------
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ITEMS = {
  watermelon: {
    label: 'Watermelon', title: ['Cut', 'Watermelon.'], no: '056', sub: 'Ice-cold and juicy.<br>Squeeze the flesh, and listen to it give.', mode: 'juicy', recipe: WATERMELON,
    hint: 'Press and squeeze the red flesh. Turn the sound on.', handle: 'Press into the flesh and squeeze: the faster you press, the louder the crunch. Hold the rind to lift the half. Flip turns it back over.',
    mass: '≈2.9<small>kg</small>', ends: [['mealy', 'crisp'], ['springy', 'dense']], flip: true, grab: 0.36, cam: { r: 7.4, half: 1.75, target: [0, 0.45, 0], phi: 1.1 }, press: 0.3,
    varieties: { crimson: { name: 'Crimson', css: 'linear-gradient(#f2455c,#d91c3a)', edge: 0xf49aa0, mid: 0xe8304a, core: 0xc9102f, white: 0xeff4da, lightGreen: 0xb4d48a, dark: 0x1c5a2a, sA: 0x0f3d1b, sB: 0x5aa043, seeds: 1 },
      yellow: { name: 'Yellow', css: 'linear-gradient(#ffd64a,#f6b800)', edge: 0xfff0b0, mid: 0xffd64a, core: 0xf6b800, white: 0xf6f4da, lightGreen: 0xc2d98f, dark: 0x2a5a24, sA: 0x1d4a1e, sB: 0x7cb04a, seeds: 1 },
      seedless: { name: 'Seedless', css: 'linear-gradient(#f8b4b6,#f2455c)', edge: 0xf49aa0, mid: 0xe8304a, core: 0xc9102f, white: 0xeff4da, lightGreen: 0xb4d48a, dark: 0x1c5a2a, sA: 0x14522a, sB: 0x6fb04e, seeds: 0 } },
    paint(v, d, geo, V) {
      const n = d.man.count, depth = d.A('a1'), cavA = d.A('a2'), rnd = d.A('rnd'), col = geo.attributes.color.array, glow = geo.attributes.aGlow.array, o = new THREE.Color();
      const edge = new THREE.Color(V.edge), mid = new THREE.Color(V.mid), core = new THREE.Color(V.core), white = new THREE.Color(V.white), lg = new THREE.Color(V.lightGreen), dk = new THREE.Color(V.dark);
      for (let i = 0; i < n; i++) {
        const dd = (depth[i] / 255) * 0.4, c = (cavA[i] / 255) * 0.8 - 0.5, rn = rnd[i] / 255; glow[i] = c;
        if (c >= 0) { o.copy(white).lerp(lg, 1 - smooth(0.035, 0.07, dd)).lerp(dk, 1 - smooth(0.012, 0.035, dd)); o.lerp(edge, 1 - smooth(0.0, 0.05, c)); }
        else { const t = Math.min(1, -c / 0.6); o.copy(edge).lerp(mid, smooth(0, 0.3, t)).lerp(core, smooth(0.3, 1, t)); o.multiplyScalar(0.97 + rn * 0.06); }
        col[i * 3] = o.r; col[i * 3 + 1] = o.g; col[i * 3 + 2] = o.b;
      }
      U.uStripeA.value.set(V.sA); U.uStripeB.value.set(V.sB); U.uSeeds.value = V.seeds;
    },
    matOpts: { roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.14 },
  },
  jelly: {
    label: 'Red Jelly', title: ['Red', 'Jelly.'], no: '057', sub: 'Cold, glossy and bouncy.<br>Poke it, pull it, and watch it jiggle.', mode: 'jelly', recipe: JELLY,
    hint: 'Poke it, press it, pull it. It wobbles back.', handle: 'A moulded red jelly. Push the side and watch it wobble, pull the top to stretch it, squeeze it with two fingers.',
    mass: '≈0.5<small>kg</small>', ends: [['trembling', 'set'], ['floaty', 'syrupy']], flip: false, grab: 0.5, cam: { r: 6.2, half: 1.3, target: [0, 0.6, 0], phi: 1.2 }, press: 0.4,
    varieties: { ruby: { name: 'Ruby', css: 'linear-gradient(#d4152f,#5a0410)', base: 0xd4152f, deep: 0x5a0410 }, cherry: { name: 'Cherry', css: 'linear-gradient(#a30f2c,#33020c)', base: 0xa30f2c, deep: 0x33020c },
      berry: { name: 'Berry', css: 'linear-gradient(#f0305a,#8a0c30)', base: 0xf0305a, deep: 0x8a0c30 } },
    paint(v, d, geo, V) { const n = d.man.count, col = geo.attributes.color.array; for (let i = 0; i < n; i++) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1; } U.uBase.value.set(V.base); U.uDeep.value.set(V.deep); },
    matOpts: { roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.08 },
    stage: { color: 0xf2efe9, r: 1.8, rough: 0.35 },
  },
  mochi: {
    label: 'Mochi', title: ['Bitten', 'Mochi.'], no: '058', sub: 'A bite out of the side, red bean inside.<br>Pull it and it clings to the plate.', mode: 'sticky', recipe: MOCHI,
    hint: 'Pull the dough up. It clings to the plate, then peels away bit by bit.', handle: 'A bite is missing from one side, showing the bean paste. Pull the dough upward: the underside stays stuck to the plate and lets go slowly from the side you pull. Let go and it sticks again.',
    mass: '≈70<small>g</small>', ends: [['gooey', 'firm'], ['loose', 'sticky']], flip: true, grab: 0.42, cam: { r: 5.2, half: 1.22, target: [0, 0.1, 0], phi: 1.0 }, press: 0.2,
    varieties: { plain: { name: 'Plain', css: 'linear-gradient(#fbf8f1,#e6dfd0)', dough: 0xf6f2ea, bean: 0x5a1f1c }, matcha: { name: 'Matcha', css: 'linear-gradient(#dbe9c6,#b5cf93)', dough: 0xcfe0b8, bean: 0x5a1f1c },
      sakura: { name: 'Sakura', css: 'linear-gradient(#fbe6e8,#f1c3c9)', dough: 0xf8dde0, bean: 0x5a1f1c } },
    paint(v, d, geo, V) { const n = d.man.count, col = geo.attributes.color.array; for (let i = 0; i < n; i++) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1; } U.uDough.value.set(V.dough); U.uBean.value.set(V.bean); },
    matOpts: { roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.3 },
    stage: { color: 0x4a4743, r: 1.45, rough: 0.45 },
  },
  bubble: {
    label: 'Bubble Block', title: ['Bubble', 'Block.'], no: '059', sub: 'Six sheets deep.<br>Press hard and go straight through.', mode: 'pop', recipe: BUBBLE,
    hint: 'Tap, press or swipe across the bubbles. Pinch to burst the ones between your fingers.', handle: 'Six separate sheets are stacked. A tap bursts the top ones; keep pressing and it goes through to the sheets below. Swipe to pop a row, pinch to burst many layers between two fingers. Refill brings them all back.',
    mass: '≈30<small>g</small>', ends: [['squishy', 'stiff'], ['floaty', 'dense']], flip: true, grab: 0.4, cam: { r: 5.4, half: 1.22, target: [0, 0.05, 0], phi: 0.98 }, press: 0.15,
    varieties: { clear: { name: 'Clear', css: 'linear-gradient(#e9f6fb,#a9d3e6)', tint: 0xdff3ff }, pink: { name: 'Pink', css: 'linear-gradient(#ffd3e1,#f08fb0)', tint: 0xffc2d8 }, mint: { name: 'Mint', css: 'linear-gradient(#cdf5df,#7dd0a6)', tint: 0xc2f5dc } },
    paint(v, d, geo, V) { const n = d.man.count, col = geo.attributes.color.array; for (let i = 0; i < n; i++) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1; } U.uTint.value.set(V.tint); },
    matOpts: { roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03, transparent: true, depthWrite: false, side: THREE.FrontSide, envMapIntensity: 1.2 }, noShadow: true, premul: true,
    stage: { color: 0x34353b, r: 1.7, rough: 0.6 },
  },
};
ITEMS.choc = {
  label: 'Crisp', title: ['Crisp', 'Chocolate.'], no: '060', sub: 'A hard shell with nuts, a soft cake inside.<br>Squeeze until it snaps.', mode: 'crisp', recipe: CRUMB,
  hint: 'Press or pinch to crack the shell. Put two fingers on it and pull them apart to tear it open.', handle: 'A hard chocolate shell with nuts, over a dry, crumbly sponge. Press and the shell cracks along lines while the cake gives way and stays crushed. Two fingers pulled apart tear the cake open; the shell stays stuck to the pieces it sits on. Reset gives you a new one.',
  mass: '≈90<small>g</small>', ends: [['brittle', 'tough'], ['loose', 'dense']], flip: false, grab: 0.45, cam: { r: 5.8, half: 1.4, target: [0, 0.3, 0], phi: 0.85 }, press: 0.3, shards: true, pieces: true,
  varieties: { dark: { name: 'Dark', css: 'linear-gradient(#3a2418,#150a06)', shell: 0x1e120c }, milk: { name: 'Milk', css: 'linear-gradient(#8a5a3a,#4a2a18)', shell: 0x4a2a1a }, ruby: { name: 'Ruby', css: 'linear-gradient(#e89aa8,#b8506a)', shell: 0x9a4558 } },
  paint(v, d, geo, V) { U.uShell.value.set(V.shell); shardMat.color.set(V.shell); },
  matOpts: { roughness: 0.95, clearcoat: 0, clearcoatRoughness: 0.4 }, engine: 'crumb', pieceOpts: { sScale: 2.5, grains: 20, tip: 0.5 },
  stage: { color: 0xece7de, r: 1.9, rough: 0.35 },
};
const ORDER = ['watermelon', 'jelly', 'mochi', 'bubble', 'choc'];
const dataCache = {};
async function loadData(id) {
  if (dataCache[id]) return dataCache[id];
  const [man, buf] = await Promise.all([fetch(`data/${id}.json`).then((r) => r.json()), fetch(`data/${id}.wasm`).then((r) => r.arrayBuffer())]);
  const A = (n) => { const a = man.arrays[n]; if (Array.isArray(a) || typeof a === 'number') return a; return new globalThis[a.type](buf, a.offset, a.length); };
  const level = (name) => {
    const m = man.levels[name], g = (k) => A(`${name}.${k}`);
    return { name, c: m.c, N: m.N, NT: m.NT, rest: g('rest'), tetIdx: g('tetIdx'), minv: g('minv'), V0: g('V0'), region: g('region'), frac: g('frac'), nodeMass: g('nodeMass'),
      skin: { ids: g('skinIds'), loc: (() => { const l = g('skinLoc'); return l instanceof Uint16Array ? Float32Array.from(l, (v) => v / 65535) : l; })(), n: man.count }, contact: { n: m.contactN, ids: g('contactIds'), loc: g('contactLoc'), pts: g('contactPts') },
      pick: { n: m.pickN, pts: g('pickPts'), ids: g('pickIds'), loc: g('pickLoc'), group: g('pickGroup') },
      extra: m.extraN ? { n: m.extraN, ids: g('extraIds'), loc: g('extraLoc') } : null };
  };
  const data = { man, A, level };
  if (man.pieces) data.pieceGeos = Array.from({ length: man.pieces }, (_, k) => ({ pos: A(`piece${k}.pos`), nrm: A(`piece${k}.nrm`), idx: A(`piece${k}.idx`), a1: A(`piece${k}.a1`), a2: A(`piece${k}.a2`), c: man.arrays[`piece${k}.c`], e: man.arrays[`piece${k}.e`] ? A(`piece${k}.e`) : null, slot: man.arrays[`piece${k}.e`] ? A(`piece${k}.slot`) : null, nb: man.arrays[`piece${k}.nb`] || [] }));
  return (dataCache[id] = data);
}

// ---------- current thing ----------
let sim = null, level = null, data = null, geo = null, fruit = null, wire = null, pickBuf = null, substeps = 6, levelName = null, curVar = null;
let bubbles = null;                       // bubble block only: centres, state texture, popped flags
const ptrs = new Map();
let orbiting = null;

let stageMesh = null, pieceMeshes = [], pcs = null, crumbSurf = null, crumbUse = null, crumbLast = null, crumbLoose = null;
function slabMaterial(c, nb = [], k = 0) {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.4, clearcoat: 0.45, clearcoatRoughness: 0.35, envMapIntensity: 1, side: THREE.DoubleSide });
  mat.userData.uOpenN = { value: new Float32Array(12) }; mat.userData.uSgnN = { value: Float32Array.from({ length: 12 }, (_, i) => (i < nb.length && k > nb[i] ? -1 : 1)) };
  mat.customProgramCacheKey = () => 'slab';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uC = { value: new THREE.Vector3(...c) }; sh.uniforms.uShell = U.uShell; sh.uniforms.uOpen = mat.userData.uOpen = { value: 0 }; sh.uniforms.uOpenN = mat.userData.uOpenN; sh.uniforms.uSgnN = mat.userData.uSgnN;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${SLAB_VERT}`).replace('#include <begin_vertex>', '#include <begin_vertex>\n vRest = position + uC; vA1 = aA1; vA2 = aA2; vE = aE; vSlot = aSlot;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_HEAD}\n${SLAB_FRAG}`).replace('#include <color_fragment>', `#include <color_fragment>
 // the shell only breaks where a joint has actually broken: a jagged fracture line (the same for both plates), a hairline first, then a raw edge
 int si = int(vSlot + 0.5); float eo = 0.0, sg = 1.0; if (si < 12) { eo = uOpenN[si]; sg = uSgnN[si]; }
 vec3 jq = vor3(vRest * 24.0); float jag = ((jq.x - 0.45) * 0.028 + (vn(vRest * 80.0) - 0.5) * 0.012 + (vn(vRest * 190.0) - 0.5) * 0.004) * sg;
 float bnd = vE + jag, T = mix(0.035, -0.006, smoothstep(0.45, 1.0, eo));
 if (bnd > T + (gl_FrontFacing ? 0.0 : 0.012)) discard;
 float crackLine = (1.0 - smoothstep(0.0, 0.003 + 0.002 * eo, abs(bnd))) * smoothstep(0.12, 0.4, eo) * (1.0 - smoothstep(0.6, 0.9, eo));
 float nutAny, outerF, cutF; diffuseColor.rgb = slabColor(vRest, vA1, vA2, nutAny, outerF, cutF);
 float rimF = (1.0 - smoothstep(0.0, 0.012, T - bnd)) * smoothstep(0.6, 1.0, eo);
 if (!gl_FrontFacing) { diffuseColor.rgb = (uShell * 2.1 + vec3(0.04, 0.025, 0.012)) * (0.75 + 0.45 * vn(vRest * 70.0)); outerF = 0.0; nutAny = 0.0; cutF = 1.0; }
 diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.012, 0.008), crackLine * 0.8);
 diffuseColor.rgb = mix(diffuseColor.rgb, uShell * 2.0 + vec3(0.03, 0.02, 0.01), rimF * 0.6);
 outerF *= 1.0 - rimF;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = mix(0.85, mix(0.42, 0.66, nutAny), outerF);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n { float hb = nutAny * (0.014 * outerF + 0.006 * cutF) + (vn(vRest * 50.0) - 0.5) * 0.004 * cutF; normal = perturbN(-vViewPosition, normal, vec2(dFdx(hb), dFdy(hb)) * 200.0); }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n material.clearcoat *= outerF * (1.0 - 0.7 * nutAny);\n#endif`);
  };
  return mat;
}
function buildPieces() {
  const geos = data.pieceGeos; pcs = new Pieces(data.man, data.A, level, item.pieceOpts || {});
  pieceMeshes = geos.map((g, k) => {
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    const nf = new Float32Array(g.nrm.length); for (let i = 0; i < nf.length; i++) nf[i] = g.nrm[i] / 127; bg.setAttribute('normal', new THREE.BufferAttribute(nf, 3));
    bg.setAttribute('aA1', new THREE.BufferAttribute(Float32Array.from(g.a1, (v) => v / 255), 1)); bg.setAttribute('aA2', new THREE.BufferAttribute(Float32Array.from(g.a2, (v) => v / 255), 1));
    bg.setIndex(new THREE.BufferAttribute(g.idx, 1)); bg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
    if (g.e) { bg.setAttribute('aE', new THREE.BufferAttribute(Float32Array.from(g.e, (v) => v / 127 * 0.06), 1)); bg.setAttribute('aSlot', new THREE.BufferAttribute(Float32Array.from(g.slot), 1)); }
    else { bg.setAttribute('aE', new THREE.BufferAttribute(new Float32Array(g.pos.length / 3).fill(-1), 1)); bg.setAttribute('aSlot', new THREE.BufferAttribute(new Float32Array(g.pos.length / 3).fill(255), 1)); }
    const mesh = new THREE.Mesh(bg, slabMaterial(g.c, g.nb, k)); mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = false; scene.add(mesh); return mesh;
  });
}
function slotPairs() {                                   // for every plate, the bond behind each of its joints (by slot)
  const key = new Map(); pcs.pairs.forEach((p, i) => key.set(Math.min(p.a, p.b) * 1000 + Math.max(p.a, p.b), i));
  pcs.slotPair = data.pieceGeos.map((g, k) => g.nb.map((j) => key.get(Math.min(k, j) * 1000 + Math.max(k, j)) ?? -1));
}
function applyPieces() {
  if (!pcs.slotPair) slotPairs();
  for (let k = 0; k < pieceMeshes.length; k++) {
    const u = pieceMeshes[k].material.userData.uOpenN.value, sp = pcs.slotPair[k], fr = pcs.state[k].free;
    for (let i = 0; i < sp.length && i < 12; i++) { const p = pcs.pairs[sp[i]]; u[i] = fr || !p ? (fr ? 1 : 0) : p.broken ? 1 : Math.min(0.42, (p.metric || 0) / p.str * 0.5); }
  }
  for (let k = 0; k < pieceMeshes.length; k++) { const s = pcs.state[k], me = pieceMeshes[k]; me.position.set(s.pos[0], s.pos[1], s.pos[2]); me.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]); if (me.material.userData.uOpen) me.material.userData.uOpen.value = s.open; me.castShadow = s.free; }
}
function setStage(st) {
  if (stageMesh) { scene.remove(stageMesh); stageMesh.geometry.dispose(); stageMesh.material.dispose(); stageMesh = null; }
  if (!st) return;
  stageMesh = new THREE.Mesh(new THREE.CylinderGeometry(st.r, st.r, 0.06, 96), new THREE.MeshStandardMaterial({ color: st.color, roughness: st.rough ?? 0.5, metalness: 0 }));
  stageMesh.position.y = -0.045; stageMesh.receiveShadow = true; scene.add(stageMesh);
}
function disposeCurrent() {
  for (const m of [fruit, wire]) if (m) { scene.remove(m); }
  for (const pm of pieceMeshes) { scene.remove(pm); pm.geometry.dispose(); pm.material.dispose(); } pieceMeshes = []; pcs = null;
  if (crumbLoose) { scene.remove(crumbLoose); crumbLoose.geometry.dispose(); crumbLoose = null; crumbSurf = null; }
  if (geo) geo.dispose(); fruit = wire = geo = null; bubbles = null; ptrs.clear(); orbiting = null;
}
function paint(name) {
  curVar = name; const V = item.varieties[name];
  item.paint(name, data, geo, V);
  if (geo && geo.attributes.color) { geo.attributes.color.needsUpdate = true; geo.attributes.aGlow.needsUpdate = true; }
  for (const k of Object.keys(item.varieties)) $('v-' + k)?.classList.toggle('on', k === name);
}
// the Crisp's cake: one continuous surface over the bonded crumb particles (rebuilt when they move), textured by rest position
// so the sponge stays put; crumbs that have broken loose are small instanced lumps
function crumbMaterial(inst) {
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.55, specularIntensity: 0.25 });
  mat.customProgramCacheKey = () => (inst ? 'crumb-inst' : 'crumb-surf');
  const VARY = 'varying vec3 vRest; varying float vRegion; varying float vGlow; varying vec3 vRestN; varying vec3 vTx; varying vec3 vTz; varying float vDmg;';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCS = U.uCS;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\nattribute vec3 aRest; ${inst ? 'attribute float aSeed;' : ''} uniform float uCS; ${VARY}\nfloat cH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }\nfloat cN(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(mix(mix(cH(i), cH(i + vec3(1,0,0)), f.x), mix(cH(i + vec3(0,1,0)), cH(i + vec3(1,1,0)), f.x), f.y), mix(mix(cH(i + vec3(0,0,1)), cH(i + vec3(1,0,1)), f.x), mix(cH(i + vec3(0,1,1)), cH(i + vec3(1,1,1)), f.x), f.y), f.z); }\nfloat crumbBump(vec3 p) { return (cN(p * 9.0) - 0.5) * 0.05 + (cN(p * 23.0 + 3.0) - 0.5) * 0.025; }   // lumpy torn crumb, also in the outline\nmat3 blobRot(float s) { float a = s * 6.2832, b = s * 17.3, ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b); return mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca) * mat3(1.0, 0.0, 0.0, 0.0, cb, sb, 0.0, -sb, cb); }`)
      .replace('#include <beginnormal_vertex>', inst ? 'mat3 bR = blobRot(aSeed); vec3 objectNormal = bR * normal;' : 'vec3 objectNormal = normal;')
      .replace('#include <begin_vertex>', (inst ? 'vec3 transformed = bR * position; vRest = aRest + transformed * uCS;' : 'vec3 transformed = position + normal * crumbBump(aRest); vRest = aRest;') + ' vRegion = 0.0; vGlow = 0.0; vRestN = normal; vTx = vec3(1.0, 0.0, 0.0); vTz = vec3(0.0, 0.0, 1.0); vDmg = 0.0;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CRUMB.color}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${CRUMB.rough}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${CRUMB.normal}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${CRUMB.emissive}`);
  };
  return mat;
}
function buildCrumbMesh() {
  const N = sim.N; crumbSurf = new CrumbSurface(sim.s); crumbUse = new Uint8Array(N); crumbLast = null;
  geo = new THREE.BufferGeometry();
  for (const [k, arr] of [['position', crumbSurf.pos], ['normal', crumbSurf.nrm], ['aRest', crumbSurf.rest]]) { const at = new THREE.BufferAttribute(arr, 3); at.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, at); }
  const ix = new THREE.BufferAttribute(crumbSurf.idx, 1); ix.setUsage(THREE.DynamicDrawUsage); geo.setIndex(ix);
  fruit = new THREE.Mesh(geo, crumbMaterial(false)); fruit.frustumCulled = false; fruit.castShadow = true; fruit.receiveShadow = true; scene.add(fruit);
  const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = 1 + 0.2 * Math.sin(x * 7.1 + y * 3.3) * Math.cos(z * 5.7 - y * 2.1); p.setXYZ(i, x * r, y * r, z * r); }
  g.computeVertexNormals();
  const ig = new THREE.InstancedBufferGeometry().copy(g), seed = new Float32Array(N); for (let i = 0; i < N; i++) seed[i] = Math.random();
  ig.setAttribute('aRest', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3)); ig.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  crumbLoose = new THREE.InstancedMesh(ig, crumbMaterial(true), N); crumbLoose.count = 0; crumbLoose.frustumCulled = false; crumbLoose.castShadow = true; crumbLoose.receiveShadow = true; scene.add(crumbLoose);
  U.uCS.value = sim.s * 0.4; updateCrumbMesh(true);
}
function updateCrumbMesh(force) {
  const P = sim.pos, nb = sim.nb, N = sim.N, use = crumbUse, s = sim.s;
  // rebuild the surface only when something moved
  let moved = force || !crumbLast; if (!moved) { const t2 = (s * 0.03) ** 2; for (let i = 0; i < N; i++) { const dx = P[i * 3] - crumbLast[i * 3], dy = P[i * 3 + 1] - crumbLast[i * 3 + 1], dz = P[i * 3 + 2] - crumbLast[i * 3 + 2]; if (dx * dx + dy * dy + dz * dz > t2) { moved = true; break; } } }
  if (!moved) return;
  crumbLast = Float32Array.from(P);
  const la = crumbLoose.instanceMatrix.array, lr = crumbLoose.geometry.attributes.aRest.array; let nl = 0;
  for (let i = 0; i < N; i++) {
    use[i] = nb[i] >= 2 ? 1 : 0; if (use[i]) continue;
    const o = nl * 16, r = s * 0.42; la.fill(0, o, o + 16); la[o] = la[o + 5] = la[o + 10] = r; la[o + 12] = P[i * 3]; la[o + 13] = P[i * 3 + 1]; la[o + 14] = P[i * 3 + 2]; la[o + 15] = 1;
    lr[nl * 3] = sim.rest[i * 3]; lr[nl * 3 + 1] = sim.rest[i * 3 + 1]; lr[nl * 3 + 2] = sim.rest[i * 3 + 2]; nl++;
  }
  crumbLoose.count = nl; crumbLoose.instanceMatrix.needsUpdate = true; crumbLoose.geometry.attributes.aRest.needsUpdate = true;
  crumbSurf.build(P, sim.rest, use, N);
  const nv = crumbSurf.nv, ni = crumbSurf.ni, at = geo.attributes;
  for (const k of ['position', 'normal', 'aRest']) { at[k].clearUpdateRanges(); at[k].addUpdateRange(0, nv * 3); at[k].needsUpdate = true; }
  geo.index.clearUpdateRanges(); geo.index.addUpdateRange(0, ni); geo.index.needsUpdate = true; geo.setDrawRange(0, ni);
}
function buildFruit(L) {
  const { man, A } = data, n = man.count;
  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(A('positions'), 3));
  const nrm = A('normals'), nf = new Float32Array(n * 3); for (let i = 0; i < nf.length; i++) nf[i] = nrm[i] / 127;
  geo.setAttribute('normal', new THREE.BufferAttribute(nf, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aRegion', new THREE.BufferAttribute(Float32Array.from(A('region')), 1));
  const ids = L.skin.ids, na = new Float32Array(n * 4), nb = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) for (let k = 0; k < 4; k++) { na[v * 4 + k] = ids[v * 8 + k]; nb[v * 4 + k] = ids[v * 8 + 4 + k]; }
  geo.setAttribute('aNodesA', new THREE.BufferAttribute(na, 4)); geo.setAttribute('aNodesB', new THREE.BufferAttribute(nb, 4));
  geo.setAttribute('aLocal', new THREE.BufferAttribute(Float32Array.from(L.skin.loc), 3));
  geo.setIndex(new THREE.BufferAttribute(A('indices'), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 8);
  paint(curVar);
  const mat = skinned(new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0, envMapIntensity: 1, ...item.matOpts }), item.recipe, true);
  fruit = new THREE.Mesh(geo, mat); fruit.frustumCulled = false; fruit.castShadow = !item.noShadow; fruit.receiveShadow = true; fruit.renderOrder = item.premul ? 2 : 0;
  fruit.customDepthMaterial = skinned(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), item.recipe, false);
  scene.add(fruit);
  wire = new THREE.Mesh(geo, skinned(new THREE.MeshBasicMaterial({ color: 0x2a2620, wireframe: true, transparent: true, opacity: 0.28, depthWrite: false }), item.recipe, false));
  wire.frustumCulled = false; wire.visible = $('mesh').checked; scene.add(wire);
}

// bubbles: six separate sheets stacked on each other. Sheet l has its own grid (shifted by OFF[l]) and sits l*T lower. Each bubble is intact or popped;
// index i = l*n + cell. The state of 4 sheets is packed in one RGBA texel (sheets 4-5 live in the right half of a 64x32 texture).
const NS = 6; let TS = 0.047;
function setupBubbles() {
  const G = data.man.grid;
  const tex = new THREE.DataTexture(new Float32Array(64 * 32 * 4), 64, 32, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  U.uBub.value = tex; U.uGrid.value.set(G.x0, G.z0, G.sx, G.sy); U.uBR.value.set(G.R, G.dome); U.uDim.value.set(G.cols, G.rows);
  const off = G.sheets; TS = G.T; off.forEach((o, l) => U.uOff.value[l].set(o[0], o[1], o[2] || 0));          // the sheets are separate pieces, each shifted a little
  const n = G.cols * G.rows, N = n * NS;
  bubbles = { G, tex, n, NS, off, state: new Float32Array(N).fill(1), target: new Float32Array(N).fill(1), alive: new Uint8Array(N).fill(1), pos: new Float32Array(N * 3), p0: new Float32Array(n * 3), left: N };
  refillBubbles(); sampleBubbles();
}
function bubbleTexIndex(i) { const n = bubbles.n, l = Math.floor(i / n), k = i % n, c = k % bubbles.G.cols, r = Math.floor(k / bubbles.G.cols); return (r * 64 + c + (l >= 4 ? 32 : 0)) * 4 + (l % 4); }
function refillBubbles() { if (!bubbles) return; bubbles.state.fill(1); bubbles.target.fill(1); bubbles.alive.fill(1); bubbles.left = bubbles.n * NS; for (let i = 0; i < bubbles.state.length; i++) bubbles.tex.image.data[bubbleTexIndex(i)] = 1; bubbles.tex.needsUpdate = true; }
function sampleBubbles() {            // sheet 0 follows the lattice; the others are the same points shifted and lowered
  const b = bubbles; sim.sample(level.extra, b.p0);
  const G = b.G;
  for (let l = 0; l < NS; l++) { const [ox, oz, ro = 0] = b.off[l], c = Math.cos(ro), s = Math.sin(ro);
    for (let k = 0; k < b.n; k++) { const r = Math.floor(k / G.cols), cx = G.x0 + (k % G.cols) * G.sx + (r % 2) * G.sx * 0.5, cz = G.z0 + r * G.sy, i = (l * b.n + k) * 3;
      b.pos[i] = b.p0[k * 3] + ox + c * cx - s * cz - cx; b.pos[i + 1] = b.p0[k * 3 + 1] - l * TS; b.pos[i + 2] = b.p0[k * 3 + 2] + oz + s * cx + c * cz - cz; } }
}
function covered(i) {                  // is an intact bubble of a higher sheet sitting over this one?
  const b = bubbles, l = Math.floor(i / b.n), p = b.pos, R2 = (b.G.R * 0.8) ** 2;
  for (let j = 0; j < l * b.n; j++) if (b.alive[j] && (p[j * 3] - p[i * 3]) ** 2 + (p[j * 3 + 2] - p[i * 3 + 2]) ** 2 < R2) return true;
  return false;
}
function pop1(i, strength, delay) {
  const b = bubbles; b.alive[i] = 0; b.left--; b.target[i] = 0;
  const p = b.pos, v = new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).project(camera), pan = Math.max(-0.6, Math.min(0.6, v.x * 0.6));
  pop(strength, pan, delay);
}
function popBubble(i, strength = 1, layers = 1) {      // pops this bubble and, if asked, goes on down through the sheets beneath it
  const b = bubbles; if (!b || !b.alive[i]) return false;
  pop1(i, strength, 0); const p = b.pos; let cur = i, k = 1;
  for (let l = Math.floor(i / b.n) + 1; l < NS && k < layers; l++) {
    let best = -1, bd = (b.G.R * 0.9) ** 2;
    for (let j = l * b.n; j < (l + 1) * b.n; j++) { if (!b.alive[j]) continue; const d = (p[j * 3] - p[cur * 3]) ** 2 + (p[j * 3 + 2] - p[cur * 3 + 2]) ** 2; if (d < bd) { bd = d; best = j; } }
    if (best < 0) continue; pop1(best, strength * (1 - k * 0.08), k * 0.034); cur = best; k++;
  }
  if (navigator.vibrate) navigator.vibrate(Math.min(24, 8 + k * 3));
  return true;
}
function nextBelow(i) {                // the first intact bubble under (or at) this one, for a press that keeps going down
  const b = bubbles, p = b.pos; if (b.alive[i]) return i;
  for (let l = Math.floor(i / b.n) + 1; l < NS; l++) { let best = -1, bd = (b.G.R * 0.9) ** 2; for (let j = l * b.n; j < (l + 1) * b.n; j++) { if (!b.alive[j]) continue; const d = (p[j * 3] - p[i * 3]) ** 2 + (p[j * 3 + 2] - p[i * 3 + 2]) ** 2; if (d < bd) { bd = d; best = j; } } if (best >= 0) return best; }
  return -1;
}
function popNear(pt, radius, strength = 1, maxN = 3, seen = null, layers = 1) {
  let k = 0; const p = bubbles.pos;                       // a few per frame at most, so a swipe sounds like a run of pops, not one burst
  for (let i = 0; i < bubbles.alive.length && k < maxN; i++) {
    if (!bubbles.alive[i] || (seen && seen.has(i))) continue;
    if (Math.hypot(p[i * 3] - pt.x, p[i * 3 + 2] - pt.z) < radius && pt.y - p[i * 3 + 1] < 0.5 && !covered(i)) { if (popBubble(i, strength, layers)) { k++; if (seen) seen.add(i); } }
  }
  return k;
}

// ---------- chocolate shards ----------
const NSH = 240, NV = 3, shardMeshes = [];
function shardGeometry(seed) {                                  // an irregular flat flake: a jittered, squashed polyhedron with flat shading
  const g = new THREE.IcosahedronGeometry(1, 0); const p = g.attributes.position, r = (k) => { const x = Math.sin(seed * 91.7 + k * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const map = new Map();
  for (let i = 0; i < p.count; i++) { const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`; if (!map.has(key)) map.set(key, [0.55 + r(map.size) * 0.9, 0.7 + r(map.size + 40) * 0.6, 0.5 + r(map.size + 80) * 0.9]); const j = map.get(key); p.setXYZ(i, p.getX(i) * j[0], p.getY(i) * j[1] * 0.14, p.getZ(i) * j[2]); }
  g.computeVertexNormals(); return g;
}
const shardMat = new THREE.MeshPhysicalMaterial({ color: 0x1e120c, roughness: 0.28, clearcoat: 0.9, clearcoatRoughness: 0.2, flatShading: true });
for (let v = 0; v < NV; v++) { const im = new THREE.InstancedMesh(shardGeometry(v + 1), shardMat, NSH / NV); im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.visible = false; im.count = 0; scene.add(im); shardMeshes.push(im); }
const sh = { p: new Float32Array(NSH * 3), v: new Float32Array(NSH * 3), q: Array.from({ length: NSH }, () => new THREE.Quaternion()), w: new Float32Array(NSH * 3), s: new Float32Array(NSH * 3), n: 0 };
const _m4 = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _ss = new THREE.Vector3(), _sp = new THREE.Vector3(), _ax = new THREE.Vector3();
function emitShards(at, n, out = 1) {
  for (let k = 0; k < n; k++) {
    const i = sh.n < NSH ? sh.n++ : (Math.random() * NSH) | 0, big = Math.random() < 0.25, sz = big ? 0.035 + Math.random() * 0.03 : 0.012 + Math.random() * 0.025;   // a few big flakes, many small crumbs
    sh.p.set([at.x + (Math.random() - 0.5) * 0.25, Math.max(0.08, at.y + (Math.random() - 0.3) * 0.2), at.z + (Math.random() - 0.5) * 0.25], i * 3);
    sh.v.set([(Math.random() - 0.5) * 2.4 * out, 1.0 + Math.random() * 2.2, (Math.random() - 0.5) * 2.4 * out], i * 3);
    sh.w.set([(Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12], i * 3);
    sh.q[i].setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)); sh.s.set([sz * (0.8 + Math.random() * 0.6), sz * (0.6 + Math.random() * 0.8), sz], i * 3);
  }
  shardMeshes.forEach((im, v) => { im.count = Math.floor((sh.n - v + NV - 1) / NV); });
}
function stepShards(dt) {
  for (let i = 0; i < sh.n; i++) {
    const k = i * 3, resting = sh.p[k + 1] <= sh.s[k + 1] * 0.5 + 0.005 && Math.abs(sh.v[k + 1]) < 0.4;
    if (!resting) {
      sh.v[k + 1] -= 9.8 * dt; sh.p[k] += sh.v[k] * dt; sh.p[k + 1] += sh.v[k + 1] * dt; sh.p[k + 2] += sh.v[k + 2] * dt;
      _ax.set(sh.w[k], sh.w[k + 1], sh.w[k + 2]); const a = _ax.length() * dt; if (a > 1e-6) { _sq.setFromAxisAngle(_ax.normalize(), a); sh.q[i].premultiply(_sq); }
      const fy = sh.s[k + 1] * 0.5;
      if (sh.p[k + 1] < fy) { sh.p[k + 1] = fy; sh.v[k + 1] *= -0.3; sh.v[k] *= 0.6; sh.v[k + 2] *= 0.6; sh.w[k] *= 0.5; sh.w[k + 1] *= 0.5; sh.w[k + 2] *= 0.5; }
    }
    _sp.set(sh.p[k], sh.p[k + 1], sh.p[k + 2]); _ss.set(sh.s[k], sh.s[k + 1], sh.s[k + 2]); _m4.compose(_sp, sh.q[i], _ss); shardMeshes[i % NV].setMatrixAt((i / NV) | 0, _m4);
  }
  for (const im of shardMeshes) im.instanceMatrix.needsUpdate = true;
}

// cake crumbs: tiny pale-yellow lumps thrown up when the shell breaks and the cake gives way
const NCR = 200, crumbs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xf0cb6e, roughness: 1 }), NCR);
crumbs.frustumCulled = false; crumbs.castShadow = true; crumbs.visible = false; crumbs.count = 0; scene.add(crumbs);
const cr = { p: new Float32Array(NCR * 3), v: new Float32Array(NCR * 3), s: new Float32Array(NCR), n: 0 };
function emitCrumbs(at, n, out = 1) {
  for (let k = 0; k < n; k++) { const i = cr.n < NCR ? cr.n++ : (Math.random() * NCR) | 0;
    cr.p.set([at.x + (Math.random() - 0.5) * 0.2, Math.max(0.05, at.y), at.z + (Math.random() - 0.5) * 0.2], i * 3);
    cr.v.set([(Math.random() - 0.5) * 2.6 * out, 0.6 + Math.random() * 2.2, (Math.random() - 0.5) * 2.6 * out], i * 3); cr.s[i] = 0.01 + Math.random() * 0.018; }
  crumbs.count = cr.n;
}
const _cm = new THREE.Matrix4(), _cp = new THREE.Vector3(), _cs = new THREE.Vector3(), _cq = new THREE.Quaternion();
function stepCrumbs(dt) {
  for (let i = 0; i < cr.n; i++) { const k = i * 3, rest = cr.p[k + 1] <= cr.s[i] + 0.004 && Math.abs(cr.v[k + 1]) < 0.3;
    if (!rest) { cr.v[k + 1] -= 9.8 * dt; cr.p[k] += cr.v[k] * dt; cr.p[k + 1] += cr.v[k + 1] * dt; cr.p[k + 2] += cr.v[k + 2] * dt; if (cr.p[k + 1] < cr.s[i]) { cr.p[k + 1] = cr.s[i]; cr.v[k + 1] *= -0.2; cr.v[k] *= 0.5; cr.v[k + 2] *= 0.5; } }
    _cp.set(cr.p[k], cr.p[k + 1], cr.p[k + 2]); _cs.set(cr.s[i], cr.s[i] * 0.7, cr.s[i]); _cm.compose(_cp, _cq, _cs); crumbs.setMatrixAt(i, _cm); }
  crumbs.instanceMatrix.needsUpdate = true;
}

// ---------- switching ----------
let switching = 0;
async function showItem(id, variety) {
  const token = ++switching;
  $('loading').hidden = false; $('loading').textContent = 'Preparing the specimen…';
  const nextData = await loadData(id);
  if (token !== switching) return;
  disposeCurrent();
  item = ITEMS[id]; data = nextData;
  document.body.dataset.item = id;
  // device probe, once: pick the lattice that fits this phone
  if (!levelName) {
    const probeSim = new Sim(data.level('mid'), SIM[id]); const h = 1 / 60 / 6;
    for (let i = 0; i < 12; i++) probeSim.step(h);
    const t0 = performance.now(); for (let i = 0; i < 48; i++) probeSim.step(h);
    const perFrame = ((performance.now() - t0) / 48) * 6; levelName = perFrame < 3 ? 'fine' : perFrame < 8 ? 'mid' : 'coarse'; substeps = levelName === 'fine' ? 8 : 6;
  }
  if (item.engine === 'crumb') {                       // the Crisp runs on bonded crumb particles instead of the lattice
    const tier = levelName, T = data.man.crumb.tiers[tier], c0 = Array.from({ length: data.man.pieces }, (_, k) => data.A(`piece${k}.c`));
    sim = new Crumb(data.A(`crumb.${tier}.pos`), T.s, data.A(`crumb.${tier}.bind`), data.man.crumb.nb, c0);
    level = { name: tier, c: T.s, extra: { plates: true, n: data.man.pieces }, pick: { n: sim.N, group: new Uint8Array(sim.N) } }; substeps = 1;
  } else {
    if (substeps === 1) substeps = levelName === 'fine' ? 8 : 6;
    level = data.level(levelName);
    sim = new Sim(level, SIM[id]);
  }
  pickBuf = new Float32Array(level.pick.n * 3);
  setFirm(0.5); setDamp(id === 'jelly' ? 0.12 : id === 'mochi' ? 0.8 : id === 'bubble' ? 0.85 : 0.3);
  curVar = variety && item.varieties[variety] ? variety : Object.keys(item.varieties)[0];
  if (item.engine === 'crumb') buildCrumbMesh(); else buildFruit(level); if (item.pieces) buildPieces(); setStage(item.stage); for (const im of shardMeshes) { im.visible = !!item.shards; im.count = 0; } sh.n = 0; crumbs.visible = !!item.shards; crumbs.count = 0; cr.n = 0; if (item.shards) shardMat.color.copy(U.uShell.value);
  if (id === 'bubble') setupBubbles();
  target.set(...item.cam.target); orbit.phi = item.cam.phi; orbit.theta = 0.5; orbit.zoom = 1;
  buildUI(); resize();
  resetSoundState();
  window.__pcs = pcs; window.__app = { shards: sh, id, sim, level, get geo() { return geo; }, get fruit() { return fruit; }, scene, THREE, camera, audio, name: levelName, bubbles, U, get substeps() { return substeps; } };
  for (let i = 0; i < 90 * substeps; i++) sim.step(1 / 60 / substeps);
  if (pcs) pcs.calibrate(sim);
  $('loading').hidden = true;
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}

// ---------- interaction ----------
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
function setRay(e) { _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); _ray.setFromCamera(_ndc, camera); }
function pick() {
  sim.sample(level.pick, pickBuf);
  const o = _ray.ray.origin, d = _ray.ray.direction, r2 = 0.085 * 0.085;
  let best = -1, bt = 1e9;
  for (let i = 0; i < level.pick.n; i++) {
    const px = pickBuf[i * 3] - o.x, py = pickBuf[i * 3 + 1] - o.y, pz = pickBuf[i * 3 + 2] - o.z, tca = px * d.x + py * d.y + pz * d.z; if (tca < 0) continue;
    const d2 = px * px + py * py + pz * pz - tca * tca;
    if (d2 < r2 && tca - Math.sqrt(r2 - d2) < bt) { bt = tca - Math.sqrt(r2 - d2); best = i; }
  }
  return best < 0 ? null : { p: [pickBuf[best * 3], pickBuf[best * 3 + 1], pickBuf[best * 3 + 2]], group: level.pick.group[best] };
}
function rayBubble() {            // the first intact bubble the pointer ray runs into (the upper sheet wins over the one beneath)
  if (!bubbles) return -1; const o = _ray.ray.origin, d = _ray.ray.direction, R = bubbles.G.R * 1.05; let best = -1, bt = 1e9; const p = bubbles.pos;
  for (let i = 0; i < bubbles.alive.length; i++) {
    if (!bubbles.alive[i]) continue;
    const px = p[i * 3] - o.x, py = p[i * 3 + 1] + 0.03 - o.y, pz = p[i * 3 + 2] - o.z, tca = px * d.x + py * d.y + pz * d.z; if (tca < 0) continue;
    const d2 = px * px + py * py + pz * pz - tca * tca; if (d2 < R * R && tca < bt) { bt = tca; best = i; }
  }
  return best;
}
let lastTap = 0, tapX = 0, tapY = 0;
canvas.addEventListener('pointerdown', (e) => {
  initAudio(); canvas.setPointerCapture(e.pointerId); setRay(e);
  const hit = pick();
  if (hit) {
    const grab = sim.startGrab(e.pointerId, hit.p, item.grab, hit.group);
    const nrmv = camera.getWorldDirection(new THREE.Vector3());
    ptrs.set(e.pointerId, { grab, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(nrmv, new THREE.Vector3(...hit.p)), hit: new THREE.Vector3(...hit.p), last: new THREE.Vector3(...hit.p), speed: 0, lastSound: 0, startX: e.clientX, startY: e.clientY, seen: new Set() });
    if (bubbles) { const b = rayBubble(); const pp = ptrs.get(e.pointerId); if (b >= 0 && popBubble(b, 1, 2)) { pp.seen.add(b); pp.hb = b; pp.hAt = performance.now(); } }
    else { playSound('squish', item.mode === 'sticky' ? 0.25 : 0.35, item.mode === 'sticky' ? 0.55 : 0.8, item.mode === 'sticky' ? 2800 : 0); if (navigator.vibrate) navigator.vibrate(8); }
    $('hint').classList.add('gone');
  } else {
    if (!orbiting) orbiting = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    const now = performance.now();
    if (item.flip && now - lastTap < 320 && Math.hypot(e.clientX - tapX, e.clientY - tapY) < 40) { sim.flip(); lastTap = 0; } else { lastTap = now; tapX = e.clientX; tapY = e.clientY; }
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (p) {
    setRay(e);
    if (_ray.ray.intersectPlane(p.plane, _v)) { p.grab.finger[0] = _v.x; p.grab.finger[1] = Math.max(0.05, _v.y); p.grab.finger[2] = _v.z; }
    if (bubbles) { const b = rayBubble(); if (b >= 0 && !p.seen.has(b) && popBubble(b, 0.8 + Math.min(0.4, p.speed * 0.05), 1)) p.seen.add(b); }
  } else if (orbiting && orbiting.id === e.pointerId) {
    orbit.theta -= (e.clientX - orbiting.x) * 0.008; orbit.phi = Math.min(1.5, Math.max(0.35, orbit.phi - (e.clientY - orbiting.y) * 0.006));
    orbiting.moved += Math.abs(e.clientX - orbiting.x) + Math.abs(e.clientY - orbiting.y); if (orbiting.moved > 12) lastTap = 0;
    orbiting.x = e.clientX; orbiting.y = e.clientY; placeCamera();
  }
});
const release = (e) => {
  const p = ptrs.get(e.pointerId);
  if (p) { const g = p.grab; if (!bubbles && Math.hypot(g.finger[0] - g.hit[0], g.finger[1] - g.hit[1], g.finger[2] - g.hit[2]) > 0.3) playSound('release', 0.6, item.mode === 'sticky' ? 0.5 : 0.7, item.mode === 'sticky' ? 3000 : 0); sim.endGrab(e.pointerId); ptrs.delete(e.pointerId); }
  if (orbiting && orbiting.id === e.pointerId) orbiting = null;
};
canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); orbit.zoom = Math.min(1.6, Math.max(0.55, orbit.zoom * (1 + e.deltaY * 0.001))); placeCamera(); }, { passive: false });

// ---------- UI ----------
function setFirm(v) { sim.setMaterial(v); $('firm').value = v; $('firmv').textContent = v.toFixed(2); }
function setDamp(v) { sim.params.damp = v; $('damp').value = v; $('dampv').textContent = v.toFixed(2); }
function buildUI() {
  $('t1').textContent = item.title[0]; $('t2').textContent = item.title[1]; $('tno').textContent = `Material studies / No. ${item.no}`; $('tsub').innerHTML = item.sub;
  $('hint').textContent = item.hint; $('hint').classList.remove('gone'); $('handle-text').textContent = item.handle; $('st-mass').innerHTML = item.mass;
  $('e1a').textContent = item.ends[0][0]; $('e1b').textContent = item.ends[0][1]; $('e2a').textContent = item.ends[1][0]; $('e2b').textContent = item.ends[1][1];
  $('flip').hidden = !item.flip; $('flip2').hidden = !item.flip; $('refill').hidden = !bubbles; $('st3-label').textContent = bubbles ? 'BUBBLES' : 'GRIP'; $('st3-unit').textContent = bubbles ? 'left' : '% holding';
  const vs = $('vars'); vs.innerHTML = '';
  for (const [k, v] of Object.entries(item.varieties)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'var'; b.id = 'v-' + k; b.innerHTML = `<b style="background:${v.css}"></b><span>${v.name}</span>`;
    b.addEventListener('click', () => paint(k)); vs.appendChild(b);
  }
  paint(curVar);
  for (const id of ORDER) $('tab-' + id).classList.toggle('on', id === item.id);
}
for (const id of ORDER) { const b = $('tab-' + id); b.addEventListener('click', () => showItem(id)); }
addEventListener('hashchange', () => { const id = location.hash.slice(1); if (ITEMS[id] && ITEMS[id] !== item) showItem(id); });
$('firm').addEventListener('input', (e) => setFirm(+e.target.value));
$('damp').addEventListener('input', (e) => setDamp(+e.target.value));
$('reset').addEventListener('click', () => { sim.reset(); ptrs.clear(); refillBubbles(); if (pcs) { pcs.reset(); pcs.wait = 100; pcs.tornSeen = 0; } sh.n = 0; crumbs.count = 0; cr.n = 0; for (const im of shardMeshes) im.count = 0; });
$('refill').addEventListener('click', () => refillBubbles());
$('flip').addEventListener('click', () => { initAudio(); sim.flip(); });
$('nudge').addEventListener('click', () => { for (let i = 0; i < sim.N; i++) { sim.vel[i * 3] += (Math.random() - 0.5) * 2; sim.vel[i * 3 + 1] += 2.6; sim.vel[i * 3 + 2] += (Math.random() - 0.5) * 2; } });
$('slow').addEventListener('change', (e) => (slow = e.target.checked));
$('mesh').addEventListener('change', (e) => { if (wire) wire.visible = e.target.checked; });
$('pause').addEventListener('click', (e) => { paused = !paused; e.currentTarget.textContent = paused ? 'Resume' : 'Pause'; });
$('sound').addEventListener('change', (e) => { audio.on = e.target.checked; initAudio(); });
$('flip2').addEventListener('click', () => $('flip').click());
$('reset2').addEventListener('click', () => $('reset').click());
$('sheet').addEventListener('click', () => document.body.classList.toggle('open'));

// ---------- loop ----------
let paused = false, slow = false, acc = 0, last = performance.now(), simMs = 8, fps = 60, hudAt = 0, frames = 0, fpsT = performance.now();
const _c = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  if (!sim) return;
  const raw = Math.min(0.05, (now - last) / 1000); last = now;
  if (!paused) {
    acc += raw * (slow ? 0.25 : 1); let steps = 0; const t0 = performance.now();
    while (acc >= 1 / 60 && steps++ < 2) { const h = 1 / 60 / substeps; for (let s = 0; s < substeps; s++) sim.step(h); acc -= 1 / 60; }
    if (acc > 1 / 60) acc = 0;
    if (steps) simMs += ((performance.now() - t0) / steps - simMs) * 0.05;
    if (simMs > 13 && substeps > 4 && frames % 30 === 0) substeps--;
  }
  const fingers = [...ptrs.values()];
  for (const p of fingers) { const f = p.grab.finger; _v.set(f[0], f[1], f[2]); p.speed = _v.distanceTo(p.last) / Math.max(raw, 1e-3); p.last.copy(_v); }
  if (bubbles) {
    sampleBubbles();
    for (const p of fingers) { const f = p.grab.finger; _v.set(f[0], f[1], f[2]); if (p.speed > 0.5) popNear(_v, bubbles.G.R * 1.1, 0.9, 3, p.seen, 1); }
    if (fingers.length >= 2) {                                         // pinch: pop what sits between two fingers as they close
      const a = fingers[0], b = fingers[1]; const sep = a.last.distanceTo(b.last); a.sep0 = a.sep0 ?? sep;
      if (sep < a.sep0 - 0.15) { _w.copy(a.last).add(b.last).multiplyScalar(0.5); a.pair = a.pair || new Set(); popNear(_w, Math.min(0.22, Math.max(0.1, sep * 0.3)), 1, 2, a.pair, 3); }
    }
    for (const p of fingers) if (p.hb >= 0 && p.speed < 1.2 && now - p.hAt > 110) { p.hAt = now; const nb = nextBelow(p.hb); if (nb >= 0) { p.hb = nb; popBubble(nb, 0.9, 2); } }        // keep pressing: it goes on through the layers
    const d = bubbles.tex.image.data; let changed = false;
    for (let k = 0; k < bubbles.state.length; k++) { const s = bubbles.state[k], t = bubbles.target[k]; if (s !== t) { bubbles.state[k] = Math.max(t, s - raw * 9); d[bubbleTexIndex(k)] = bubbles.state[k]; changed = true; } }
    if (changed) bubbles.tex.needsUpdate = true;
  }
  const snaps = sim.snaps; sim.snaps = 0;
  soundFrame(item.mode, now, raw, { fingers, strain: item.engine === 'crumb' ? sim.flow : sim.strain, impact: sim.impact, gyr: sim.gyration(), held: ptrs.size > 0, snaps });
  sim.impact = 0;
  const d = nodeTex.image.data, P = sim.pos;
  if (item.engine === 'crumb') updateCrumbMesh();
  else for (let i = 0; i < sim.N; i++) { d[i * 4] = P[i * 3]; d[i * 4 + 1] = P[i * 3 + 1]; d[i * 4 + 2] = P[i * 3 + 2]; d[i * 4 + 3] = 0; }
  if (pcs) {
    const hits = fingers.map((p) => p.grab.finger);
    if (pcs.wait > 0 && --pcs.wait === 0) pcs.calibrate(sim);
    if (!paused) pcs.update(sim, raw, hits);
    let nCrack = 0;
    if (item.engine === 'crumb') {                       // the sound of the version you liked: a granular crunch every frame the bun is being broken
      let plates = 0; for (const ev of pcs.events) if (!ev.landed) plates++;
      const dmg = (sim.torn - (pcs.tornSeen || 0)) + plates * 6; pcs.tornSeen = sim.torn;
      if (dmg >= 3) { crunch(Math.min(1, dmg / 30)); nCrack = 9; if (navigator.vibrate && dmg > 12) navigator.vibrate(8); }
    }
    for (const ev of pcs.events) {
      _v.set(ev.at[0], ev.at[1], ev.at[2]);
      if (ev.landed) { if (item.engine === 'crumb') { if (Math.random() < 0.5) crunch(0.15 + 0.2 * ev.strength); } else if (nCrack < 5) { crack(0.35 * ev.strength + 0.15); nCrack++; } emitCrumbs(_v, 2, 0.5); continue; }
      if (nCrack < 4) { crack(ev.freed ? 0.8 : 0.5 + 0.5 * ev.strength); nCrack++; }                      // a burst of breaks is a burst of crunch, not one voice per bond
      emitShards(_v, ev.freed ? Math.min(5, 1 + (ev.size || 1)) : 1, 0.5); emitCrumbs(_v, ev.freed ? 4 + (ev.size || 1) * 2 : 3, 1); if (navigator.vibrate && nCrack <= 1) navigator.vibrate(ev.freed ? 12 : 8);
    }
    applyPieces(); stepShards(raw); stepCrumbs(raw);
  }
  nodeTex.needsUpdate = true;
  renderer.render(scene, camera);
  frames++;
  if (now - fpsT > 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now; }
  if (now - hudAt > 400) {
    hudAt = now;
    $('hud').textContent = `WEBGL2 · LIVE | FPS ${fps.toFixed(0)} | LATTICE ${level.c.toFixed(2)} | SUB ×${substeps}`;
    $('st-vol').textContent = (sim.volRatio * 100).toFixed(1);
    $('st-grip').textContent = bubbles ? bubbles.left : (sim.grip() * 100).toFixed(0);
  }
}
for (const k of ORDER) { ITEMS[k].id = k; ITEMS[k].recipe.key = k; }
(async () => {
  const id = ITEMS[location.hash.slice(1)] ? location.hash.slice(1) : 'watermelon';
  await showItem(id);
  requestAnimationFrame(frame);
})();
