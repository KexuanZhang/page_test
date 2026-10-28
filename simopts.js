// How each thing behaves. `mat` sets compliance per material region (rind / pith-or-body / flesh) from a 0..1 firmness.
export const SIM = {
  watermelon: {
    gravity: -20, hold: [6, 3, 1.4], groups: true, strainRegion: 2, friction: 0.9,
    plastic: { region: 2, yield: 0.18, rate: 0.18, recover: 0.0006, maxDev: 0.45 },
    mat: (k, rd, rh) => { rd[0] = 0.02; rh[0] = 0.02; rd[1] = 2 * k; rh[1] = k ** 0.5; rd[2] = 70 * k; rh[2] = 14 * k ** 0.6; },
  },
  jelly: {
    gravity: -20, hold: [6, 6, 6], strainRegion: 2, friction: 0.9,
    mat: (k, rd, rh) => { rd[2] = 22 * k; rh[2] = 2.5 * k ** 0.6; rd[0] = rd[1] = rd[2]; rh[0] = rh[1] = rh[2]; },
  },
  mochi: {
    // very soft, sticky dough around a firmer bean-paste core; it stays glued to the plate until it is peeled off
    gravity: -20, hold: [6, 6, 6], strainRegion: 1, friction: 1, adhesion: 0.3, drag: 2.5, tether: { len: 0.6, k: 0.6, layers: 2.2, thread: 3.5 },     // holds on long, lets go from the pulled side first, then hangs on by threads
    plastic: { region: 1, yield: 0.045, rate: 3, cap: 0.5, recover: 0.0004, maxDev: 1.6 },          // dough: stretched stays stretched, no spring back
    mat: (k, rd, rh) => { rd[0] = 11 * k; rh[0] = 2 * k ** 0.6; rd[1] = 14 * k; rh[1] = 2.2 * k ** 0.6; rd[2] = 7 * k; rh[2] = 1.3 * k ** 0.6; },
  },
  bubble: {
    // a thin plastic film: flexible, heavily damped, and it keeps whatever shape it is crushed into
    gravity: -20, hold: [6, 0.9, 6], strainRegion: 1, friction: 0.95, drag: 2, verticalGrab: true,
    plastic: { region: 1, yield: 0.03, rate: 0.5, recover: 0, maxDev: 1.2 },
    mat: (k, rd, rh) => { rd[0] = rd[1] = rd[2] = 4 * k; rh[0] = rh[1] = rh[2] = 1 * k ** 0.6; },
  },
  choc: {
    // a hard thin shell over a bread-like crumb: the crumb crushes and stays crushed (very little springback)
    gravity: -20, hold: [6, 6, 6], strainRegion: 2, friction: 0.95, drag: 2,
    plastic: { region: 2, region2: 0, yield: 0.04, rate: 4, cap: 0.9, recover: 0, maxDev: 3 },
    mat: (k, rd, rh) => { rd[0] = 3 * k; rh[0] = 0.8 * k ** 0.6; rd[1] = rd[0]; rh[1] = rh[0]; rd[2] = 18 * k; rh[2] = 60 * k ** 0.6; },
  },
};
