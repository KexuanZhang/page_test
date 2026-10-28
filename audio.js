// Sound for every thing, switched by mode:
//   juicy     watermelon  recorded CC0 apple bite, wet squishes, drips and splats, driven by how fast the flesh deforms
//   jelly     red jelly   CC0 squish clips on touch, a synthesised spring "duang" on every wobble, a splat on landing
//   sticky    mochi       low wet clicks and "blup"s that follow the stretch, a soft release when it peels off the plate
//   pop       bubbles     a bank of synthesised plastic pops (sharp crack + air thump + crinkle), plus quiet CC0 body
export const audio = { juice: [], tacky: [], cracks: [], ctx: null, on: true, buffers: {}, last: {}, plays: 0, grains: 0, hi: [], lo: [], pops: [], intensity: 0, pending: [] };

// ---- DSP helpers (run once at start; the buffers are then just played) ----
function bandpassed(sr, n, fc, q, env) {
  const out = new Float32Array(n), w = 2 * Math.PI * fc / sr, al = Math.sin(w) / (2 * q), b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) { const x = (Math.random() * 2 - 1) * env(i / sr), y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y; }
  return out;
}
const normalise = (a, peak = 1) => { let m = 1e-9; for (const v of a) m = Math.max(m, Math.abs(v)); for (let i = 0; i < a.length; i++) a[i] = a[i] / m * peak; return a; };
const toBuffer = (ctx, a) => { const b = ctx.createBuffer(1, a.length, ctx.sampleRate); b.copyToChannel(a, 0); return b; };
function grainBuffer(ctx, fc, q, len, decay) { const n = Math.floor(ctx.sampleRate * len); return toBuffer(ctx, normalise(bandpassed(ctx.sampleRate, n, fc, q, (t) => Math.exp(-t / (len * decay))))); }

// one plastic bubble pop: a bright crack, a short tick of shell, escaping air, and the crinkle of the film around it.
// Kept well above 1 kHz on purpose: phone speakers cannot play lows, and lows are what makes a pop sound muffled.
function popBuffer(ctx, bright) {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.14), out = new Float32Array(n);
  const crack = bandpassed(sr, n, 4200 + bright * 2600, 0.8, (t) => Math.exp(-t / 0.0016));          // the sharp snap
  const tick = bandpassed(sr, n, 2600 + bright * 1400, 1.4, (t) => Math.exp(-t / 0.006));            // the shell ringing, short
  const hiss = bandpassed(sr, n, 8500, 0.6, (t) => Math.exp(-t / 0.011));                            // escaping air
  const click = bandpassed(sr, n, 6500, 0.5, (t) => (t < 0.0012 ? 1 : 0));                           // the first instant
  const body = bandpassed(sr, n, 1250 + bright * 500, 1.3, (t) => Math.exp(-t / 0.0075));              // a little body, so it is a pop and not static
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = 1100 + 1500 * Math.exp(-t / 0.004);                                        // a thin high "tok", not a thump
    ph += 2 * Math.PI * f / sr;
    out[i] = crack[i] * 3.0 + tick[i] * 1.4 + hiss[i] * 1.2 + click[i] * 1.8 + body[i] * 2.4 + Math.sin(ph) * Math.exp(-t / 0.005) * 0.3;
  }
  const clicks = 3 + Math.floor(Math.random() * 4);
  for (let k = 0; k < clicks; k++) {
    const at = Math.floor(sr * (0.006 + Math.random() * 0.06)), amp = 0.35 + Math.random() * 0.4, fc = 4200 + Math.random() * 4000;
    const c = bandpassed(sr, Math.floor(sr * 0.005), fc, 2, (t) => Math.exp(-t / 0.001));
    for (let i = 0; i < c.length && at + i < n; i++) out[at + i] += c[i] * amp;
  }
  let hp = 0, prev = 0; for (let i = 0; i < n; i++) { hp = 0.95 * (hp + out[i] - prev); prev = out[i]; out[i] = hp; }   // one-pole high-pass, removes any boom
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.2);
  return toBuffer(ctx, normalise(out, 0.95));
}

// brittle chocolate snap: a hard click, a few bright fracture ticks, and a short dry knock underneath
function crackBuffer(ctx, v) {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.22), out = new Float32Array(n);
  const snap = bandpassed(sr, n, 3200 + v * 2600, 0.7, (t) => Math.exp(-t / 0.004)), tick = bandpassed(sr, n, 5200, 1.0, (t) => Math.exp(-t / 0.002));
  for (let i = 0; i < n; i++) { const t = i / sr; out[i] = snap[i] * 2.6 + Math.sin(2 * Math.PI * (230 + v * 90) * t) * Math.exp(-t / 0.022) * 0.9; }
  for (let k = 0; k < 4 + (v * 3 | 0); k++) { const at = Math.floor(sr * (0.004 + Math.random() * 0.12)), amp = 0.4 + Math.random() * 0.7; for (let i = 0; i < tick.length && at + i < n; i++) out[at + i] += tick[i] * amp * Math.exp(-at / sr / 0.06) * (0.5 + Math.random() * 0.5) * (i < 400 ? 1 : 0); }
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 1.1);
  return toBuffer(ctx, normalise(out, 0.95));
}
// watermelon: a wet squelch. Many tiny bursting cells (short resonant pings, like bubbles of juice), a soft watery body, and a few
// crisp ticks from the flesh giving way
function juiceBuffer(ctx, v) {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.3), out = new Float32Array(n);
  for (let b = 0; b < 26 + (v * 20 | 0); b++) {
    const at = Math.floor(sr * Math.pow(Math.random(), 1.6) * 0.22), f0 = 500 + Math.random() * 2200, dec = 0.006 + Math.random() * 0.02, amp = (0.25 + Math.random() * 0.75) * Math.exp(-at / sr / 0.12), up = 1 + Math.random() * 0.9;
    for (let i = 0; at + i < n && i < sr * dec * 5; i++) { const t = i / sr; out[at + i] += Math.sin(2 * Math.PI * f0 * (t + up * t * t / (2 * dec * 3))) * Math.exp(-t / dec) * amp; }
  }
  let lp = 0; for (let i = 0; i < n; i++) { const t = i / sr; lp += ((Math.random() * 2 - 1) - lp) * 0.08; out[i] += lp * 1.6 * Math.exp(-t / 0.09) * (1 - Math.exp(-t / 0.004)); }
  const tick = bandpassed(sr, 600, 4200, 1.2, (t) => Math.exp(-t / 0.0015));
  for (let k = 0; k < 3 + (v * 4 | 0); k++) { const at = Math.floor(sr * Math.random() * 0.12); for (let i = 0; i < tick.length && at + i < n; i++) out[at + i] += tick[i] * 0.5; }
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * 0.9);
  return toBuffer(ctx, normalise(out, 0.9));
}
// mochi: a sticky peel. A dense patter of little tacky clicks as the dough lets go, over a soft wet suck
function tackyBuffer(ctx, v) {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.22), out = new Float32Array(n);
  const tick = bandpassed(sr, 400, 1800 + v * 1600, 1.4, (t) => Math.exp(-t / 0.0022));
  for (let k = 0; k < 18 + (v * 14 | 0); k++) { const at = Math.floor(sr * Math.random() * 0.16), amp = (0.3 + Math.random() * 0.7) * (1 - at / n); for (let i = 0; i < tick.length && at + i < n; i++) out[at + i] += tick[i] * amp; }
  for (let i = 0; i < n; i++) { const t = i / sr, f = 320 - 180 * Math.min(1, t / 0.12); out[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.07) * (1 - Math.exp(-t / 0.01)) * 0.8; }
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i]);
  return toBuffer(ctx, normalise(out, 0.9));
}
export function squelch(strength = 0.6, delay = 0) {
  if (!audio.on || !audio.ctx || !audio.juice.length) return;
  play(audio.juice[(Math.random() * audio.juice.length) | 0], 0.2 + strength * 0.55, 0.85 + Math.random() * 0.35, delay);
  if (strength > 0.4 && Math.random() < 0.6) playSound('squish', 0.15 + strength * 0.3, 1.05 + Math.random() * 0.2);
  audio.plays++;
}
function drip(vol, f) {                                  // one bursting cell of juice: a tiny rising "plip"
  const ctx = audio.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.025);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  o.connect(g).connect(audio.master); o.start(t); o.stop(t + 0.06);
}
export function tacky(strength = 0.6) {
  if (!audio.on || !audio.ctx || !audio.tacky.length) return;
  play(audio.tacky[(Math.random() * audio.tacky.length) | 0], 0.2 + strength * 0.45, 0.9 + Math.random() * 0.3); audio.plays++;
}
// the break sound is the granular crunch (bright, sandy, quick): a burst of high grains with a few lower ones under it
export function crack(strength = 1, delay = 0) {
  if (!audio.on || !audio.ctx) return;
  const s = Math.min(1, strength), n = 5 + Math.round(s * 7);
  for (let i = 0; i < n; i++) play(audio.hi[(Math.random() * audio.hi.length) | 0], 0.14 + s * 0.3 * Math.random(), 0.9 + Math.random() * 0.7, delay + Math.random() * 0.06);
  for (let i = 0; i < 2 + Math.round(s * 3); i++) play(audio.lo[(Math.random() * audio.lo.length) | 0], 0.12 + s * 0.26 * Math.random(), 0.8 + Math.random() * 0.6, delay + Math.random() * 0.05);
  audio.plays++;
}
export async function initAudio() {
  if (audio.ctx) { audio.ctx.resume?.(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = audio.ctx = new AC();
  audio.master = ctx.createGain(); audio.master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.1;
  audio.master.connect(comp).connect(ctx.destination);
  for (let i = 0; i < 28; i++) audio.hi.push(grainBuffer(ctx, 2200 + Math.random() * 5600, 2.2 + Math.random() * 2, 0.007 + Math.random() * 0.016, 0.22));
  for (let i = 0; i < 14; i++) audio.lo.push(grainBuffer(ctx, 650 + Math.random() * 1700, 1.1 + Math.random(), 0.018 + Math.random() * 0.03, 0.3));
  for (let i = 0; i < 14; i++) audio.pops.push(popBuffer(ctx, i / 13));
  for (let i = 0; i < 8; i++) audio.cracks.push(crackBuffer(ctx, i / 7));
  for (let i = 0; i < 10; i++) audio.juice.push(juiceBuffer(ctx, i / 9));
  for (let i = 0; i < 8; i++) audio.tacky.push(tackyBuffer(ctx, i / 7));
  const sr = ctx.sampleRate, nb = ctx.createBuffer(1, sr * 2, sr), d = nb.getChannelData(0); let lp = 0;
  for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; lp += (w - lp) * 0.55; d[i] = w * 0.6 + lp * 0.5; }
  const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 4200; bp.Q.value = 0.6;
  audio.bedGain = ctx.createGain(); audio.bedGain.gain.value = 0;
  src.connect(hp).connect(bp).connect(audio.bedGain).connect(audio.master); src.start();
  try {
    const manifest = await (await fetch('sounds/index.json')).json();
    for (const [kind, files] of Object.entries(manifest)) {
      const bufs = await Promise.all(files.map(async (f) => { try { return await ctx.decodeAudioData(await (await fetch('sounds/' + f)).arrayBuffer()); } catch { return null; } }));
      audio.buffers[kind] = bufs.filter(Boolean);
    }
  } catch { /* the synthesised sounds still work */ }
}

function play(buf, vol, rate, delay = 0, pan = 0) {
  const ctx = audio.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = buf; s.playbackRate.value = rate; g.gain.value = vol;
  let node = g; if (ctx.createStereoPanner && pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
  s.connect(g); node.connect(audio.master); s.start(ctx.currentTime + delay); audio.grains++;
}
export function playSound(kind, vol, rate, lowpass = 0) {
  const list = audio.buffers[kind];
  if (!audio.on || !audio.ctx || !list || !list.length) return;
  let i; do { i = (Math.random() * list.length) | 0; } while (list.length > 1 && i === audio.last[kind]);
  audio.last[kind] = i;
  const ctx = audio.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = list[i]; s.playbackRate.value = rate * (0.92 + Math.random() * 0.16); g.gain.value = Math.min(1, vol);
  if (lowpass) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; s.connect(f).connect(g); } else s.connect(g);
  g.connect(audio.master); s.start(); audio.plays++;
}

// ---- bubbles ----
export function pop(strength = 1, pan = 0, delay = 0) {
  if (!audio.on || !audio.ctx || !audio.pops.length) return;
  const i = (Math.random() * audio.pops.length) | 0;
  play(audio.pops[i], 0.6 + 0.4 * Math.min(1, strength), 0.95 + Math.random() * 0.3, delay, pan);
  audio.plays++;
}

// ---- watermelon ----
export function crunch(strength) {
  if (!audio.on || !audio.ctx) return;
  const n = 4 + Math.round(strength * 5);
  for (let i = 0; i < n; i++) play(audio.lo[(Math.random() * audio.lo.length) | 0], 0.16 + strength * 0.3 * Math.random(), 0.8 + Math.random() * 0.6, Math.random() * 0.07);
  for (let i = 0; i < n; i++) play(audio.hi[(Math.random() * audio.hi.length) | 0], 0.1 + strength * 0.2 * Math.random(), 0.8 + Math.random() * 0.5, Math.random() * 0.08);
}
function rustle(intensity, dt, bed = true) {
  if (!audio.ctx) return;
  const I = audio.on ? intensity : 0;
  audio.bedGain.gain.setTargetAtTime(bed ? Math.min(0.32, I * 0.3) : 0, audio.ctx.currentTime, 0.04);
  if (I < 0.03) return;
  const expected = I * 120 * dt; let n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0); n = Math.min(n, 9);
  for (let i = 0; i < n; i++) play(audio.hi[(Math.random() * audio.hi.length) | 0], (0.04 + Math.min(1, I) * 0.2) * (0.4 + Math.random() * 0.6), 0.85 + Math.random() * 0.7, Math.random() * Math.min(0.02, dt));
}

// ---- jelly ----
export function duang(amp, up) {
  if (!audio.on || !audio.ctx) return;
  const ctx = audio.ctx, t = ctx.currentTime, f0 = (up ? 210 : 165) * (1.25 - Math.min(0.5, amp * 8)), dur = 0.28 + Math.min(0.3, amp * 6);
  const out = ctx.createGain(); out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(Math.min(0.9, 0.25 + amp * 8), t + 0.006); out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; out.connect(lp).connect(audio.master);
  for (const [mult, level, decay] of [[1, 1, 1], [2.01, 0.35, 0.5], [3.4, 0.12, 0.25]]) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = mult === 1 ? 'sine' : 'triangle';
    o.frequency.setValueAtTime(f0 * mult * 1.35, t); o.frequency.exponentialRampToValueAtTime(f0 * mult * 0.8, t + dur * 0.9);
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 17; lg.gain.setValueAtTime(f0 * mult * 0.07, t); lg.gain.exponentialRampToValueAtTime(0.01, t + dur);
    lfo.connect(lg).connect(o.frequency); g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * decay);
    o.connect(g).connect(out); o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  }
  audio.plays++;
}

// ---- mochi: a small wet "blup" ----
export function blup(vol = 0.3, pitch = 1) {
  if (!audio.on || !audio.ctx) return;
  const ctx = audio.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), f = (250 + Math.random() * 150) * pitch;
  o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 2.7, t + 0.03);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  o.connect(g).connect(audio.master); o.start(t); o.stop(t + 0.08); audio.plays++;
}

const st = { prevStrain: null, rate: 0, crunchAt: 0, impactAt: 0, buzzAt: 0, prevI: 0, wob: { prev: 0, slope: 0, at: 0 }, blupAt: 0, snapAt: 0 };
export function resetSoundState() { st.prevStrain = null; st.rate = 0; st.prevI = 0; st.wob.prev = 0; st.wob.slope = 0; }

// env: { fingers, strain, impact, gyr, held, snaps }
export function soundFrame(mode, now, dt, env) {
  if (!audio.ctx) return;
  const { fingers, strain, impact, gyr, held, snaps } = env;
  if (st.prevStrain === null) st.prevStrain = strain;
  const raw = Math.abs(strain - st.prevStrain) / Math.max(dt, 1e-3); st.prevStrain = strain;
  st.rate += (raw - st.rate) * 0.5;
  let I = Math.max(0, st.rate - 0.04) / 0.45; for (const f of fingers) I += Math.min(0.35, f.speed * 0.04); I = Math.min(1.3, I); audio.intensity = I;
  if (mode !== 'granular' && mode !== 'crisp') audio.bedGain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.04);

  if (mode === 'granular' || mode === 'crisp') {
    rustle(I, dt);
    if (I > 0.65 && I - st.prevI > 0.12 && now - st.crunchAt > 160) { st.crunchAt = now; crunch(Math.min(1, I)); }
    if (impact > 1.8 && now - st.impactAt > 220) { st.impactAt = now; playSound('impact', 0.25 + Math.min(0.6, impact / 7), 0.75); }
  } else if (mode === 'jelly') {
    for (const f of fingers) if (f.speed > 1.1 && now - f.lastSound > 150) { f.lastSound = now; playSound('squish', 0.25 + Math.min(0.6, f.speed / 7), 0.85 + Math.min(0.4, f.speed / 12)); }
    if (impact > 1.8 && now - st.impactAt > 220) { st.impactAt = now; playSound('impact', 0.25 + Math.min(0.7, impact / 6), 0.95); }
    const w = st.wob, slope = gyr - w.prev;
    if (Math.sign(slope) !== Math.sign(w.slope) && Math.abs(gyr) > 0.0025 && now - w.at > 150 && !held) { w.at = now; duang(Math.min(0.12, Math.abs(gyr) * 14), gyr < 0); }
    if (Math.abs(slope) > 1e-6) w.slope = slope; w.prev = gyr;
  } else if (mode === 'juicy') {
    // a ripe watermelon, from real recordings: a crisp wet bite as the flesh gives way, wet squishes as it is worked, drips of juice, a splat on landing
    const bite = (v) => { playSound('bite', 0.35 + v * 0.55, 0.74 + Math.random() * 0.2); playSound('wet', 0.2 + v * 0.35, 0.8 + Math.random() * 0.3); };
    if (I > 0.3 && I - st.prevI > 0.08 && now - st.crunchAt > 150) { st.crunchAt = now; bite(Math.min(1, I)); }
    for (const f of fingers) if (f.speed > 1.4 && now - f.lastSound > 200) { f.lastSound = now; playSound('wet', 0.25 + Math.min(0.5, f.speed / 10), 0.85 + Math.random() * 0.35); }
    if (I > 0.12 && Math.random() < I * 1.6 * dt) playSound('drip', 0.08 + Math.min(0.2, I * 0.15), 1.1 + Math.random() * 0.8);
    if (impact > 1.8 && now - st.impactAt > 220) { st.impactAt = now; playSound('splat', 0.3 + Math.min(0.6, impact / 7), 0.85 + Math.random() * 0.2); }
  } else if (mode === 'sticky') {
    // sticky and chewy: wet squishes, bright little blups as the dough stretches, a tacky peel each time it lets go of the plate
    for (const f of fingers) if (f.speed > 0.8 && now - f.lastSound > 180) { f.lastSound = now; playSound('squish', 0.2 + Math.min(0.4, f.speed / 9), 0.8, 3200); }
    if (I > 0.08 && now - st.blupAt > 90 / (0.4 + I)) { st.blupAt = now; blup(0.12 + Math.min(0.25, I * 0.2), 0.85 + Math.random() * 0.5); }
    if (held && I > 0.15 && Math.random() < I * 4 * dt) tacky(0.25 + Math.min(0.4, I * 0.3));
    if (snaps >= 1 && now - st.snapAt > 90) { st.snapAt = now; tacky(Math.min(1, 0.4 + snaps * 0.1)); if (snaps >= 3) blup(0.3, 0.9); }
    if (impact > 1.8 && now - st.impactAt > 220) { st.impactAt = now; playSound('impact', 0.2 + Math.min(0.4, impact / 9), 0.6, 2600); }
  }
  st.prevI = I;
  if (mode !== 'pop' && I > 0.12 && navigator.vibrate && now - st.buzzAt > 55) { st.buzzAt = now; navigator.vibrate(Math.min(8, 2 + Math.round(I * 5))); }
}

