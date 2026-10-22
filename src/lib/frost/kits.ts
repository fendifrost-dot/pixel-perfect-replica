/**
 * Built-in drum kits, synthesized in the app from oscillators, noise and filters. No audio assets
 * ship with the app, and a kit drum is regenerated bit-for-bit on reopen (seeded noise), so
 * projects that use kits stay small and never lose their drums.
 *
 * A drum renders to mono Float32 samples; engine.ts wraps that in an AudioBuffer and registers it
 * as a `kit` source. From there it is an ordinary pad: pitch, volume, pan, reverse, choke, gate /
 * loop, fades and tempo-fit all apply exactly as they do to a chop.
 */

export interface DrumDef {
  id: string;
  name: string;
  /** Short label for a pad (≤ 8 chars). */
  short: string;
  /** Pad volume (0..1) the drum starts at: a balanced kit sits below 0 dB with nothing adjusted. */
  level: number;
  render: (sr: number) => Float32Array;
}

export interface KitDef {
  id: string;
  name: string;
  /** One line on the sound and the style it suits. */
  blurb: string;
  drums: DrumDef[];
}

// ---------------------------------------------------------------- DSP building blocks

/** Deterministic PRNG (mulberry32) so a drum renders identically every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian white noise, seeded. */
function noise(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    // Box–Muller
    const u = Math.max(1e-12, r()),
      v = r();
    const m = Math.sqrt(-2 * Math.log(u));
    out[i] = m * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = m * Math.sin(2 * Math.PI * v);
  }
  return out;
}

/** Exponential decay (time constant `decay` s) after an optional hold. */
function env(n: number, sr: number, decay: number, hold = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = t < hold ? 1 : Math.exp(-(t - hold) / decay);
  }
  return out;
}

/** Sine whose frequency falls exponentially from f0 to f1 with time constant tau. */
function sweep(n: number, sr: number, f0: number, f1: number, tau: number, harmonic = 1): Float32Array {
  const out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f1 + (f0 - f1) * Math.exp(-i / sr / tau);
    ph += (2 * Math.PI * f * harmonic) / sr;
    out[i] = Math.sin(ph);
  }
  return out;
}

function sine(n: number, sr: number, f: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * f * i) / sr);
  return out;
}

function square(n: number, sr: number, f: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * f * i) / sr) >= 0 ? 1 : -1;
  return out;
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** RBJ cookbook 2nd-order sections. */
function coeffs(kind: "lp" | "hp" | "bp", sr: number, f: number, q: number): Biquad {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w),
    sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === "lp") {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
  } else if (kind === "hp") {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function biquad(x: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Butterworth-ish filters: `order` is the number of cascaded 2nd-order sections. */
const lp = (x: Float32Array, sr: number, f: number, order = 1) => {
  for (let k = 0; k < order; k++) x = biquad(x, coeffs("lp", sr, f, Math.SQRT1_2));
  return x;
};
const hp = (x: Float32Array, sr: number, f: number, order = 1) => {
  for (let k = 0; k < order; k++) x = biquad(x, coeffs("hp", sr, f, Math.SQRT1_2));
  return x;
};
const bp = (x: Float32Array, sr: number, lo: number, hi: number, order = 1) => {
  // band-pass as high-pass then low-pass, which keeps the passband flat for wide bands
  return lp(hp(x, sr, lo, order), sr, hi, order);
};

function mul(a: Float32Array, b: Float32Array, g = 1): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i] * g;
  return out;
}

function add(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

function gain(x: Float32Array, g: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/** Soft clip (tanh), console / tape style. */
function sat(x: Float32Array, drive: number): Float32Array {
  const out = new Float32Array(x.length);
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) out[i] = Math.tanh(x[i] * drive) / k;
  return out;
}

/** Tiny early-reflection "room" for acoustic-style hits. */
function room(x: Float32Array, sr: number, size: number, mix: number, decay: number): Float32Array {
  const n = x.length;
  const out = Float32Array.from(x);
  for (const [d, g] of [
    [size * 0.7, 0.5],
    [size, 0.4],
    [size * 1.6, 0.3],
    [size * 2.3, 0.2],
  ]) {
    const k = Math.round(d * sr);
    for (let i = k; i < n; i++) out[i] += g * mix * x[i - k] * Math.exp(-(i - k) / sr / decay);
  }
  return out;
}

/** Add `offsets` delayed copies (seconds) of a short noise burst — the multi-hand clap shape. */
function clapBursts(n: number, sr: number, seed: number, offsets: number[], shortDecay: number, tailDecay: number, lo: number, hi: number) {
  const out = new Float32Array(n);
  offsets.forEach((off, i) => {
    const k = Math.round(off * sr);
    const burst = mul(bp(noise(n - k, seed + i), sr, lo, hi), env(n - k, sr, i < offsets.length - 1 ? shortDecay : tailDecay));
    for (let j = 0; j < burst.length; j++) out[k + j] += burst[j];
  });
  return out;
}

/** Short linear fade-in (avoid DC click) and fade-out, then peak-normalise. */
function finish(x: Float32Array, sr: number, peak = 0.9, outMs = 5): Float32Array {
  const out = Float32Array.from(x);
  const kin = Math.round(0.0005 * sr);
  for (let i = 0; i < kin && i < out.length; i++) out[i] *= i / kin;
  const kout = Math.round((outMs / 1000) * sr);
  for (let i = 0; i < kout && i < out.length; i++) out[out.length - 1 - i] *= i / kout;
  let m = 0;
  for (const v of out) m = Math.max(m, Math.abs(v));
  return gain(out, m > 0 ? peak / m : 1);
}

const secs = (s: number, sr: number) => Math.round(s * sr);

// ---------------------------------------------------------------- Kit: "Westside" (punchy, saturated, acoustic-flavoured)

const westside: KitDef = {
  id: "westside",
  name: "Westside",
  blurb: "Punchy, saturated, live-room flavour. Boom bap and G-funk.",
  drums: [
    {
      id: "kick",
      name: "Kick",
      short: "Kick",
      level: 0.8,
      render: (sr) => {
        const n = secs(0.45, sr);
        const body = mul(sweep(n, sr, 170, 52, 0.035), env(n, sr, 0.16), 1.1);
        const beater = mul(hp(noise(n, 11), sr, 2500), env(n, sr, 0.003), 0.6);
        const knock = mul(bp(noise(n, 12), sr, 300, 900), env(n, sr, 0.012), 0.4);
        return finish(lp(sat(add(body, beater, knock), 2.5), sr, 9000), sr);
      },
    },
    {
      id: "snare",
      name: "Snare",
      short: "Snare",
      level: 0.7,
      render: (sr) => {
        const n = secs(0.42, sr);
        const shell = mul(add(gain(sine(n, sr, 185), 0.6), gain(sine(n, sr, 330), 0.35)), env(n, sr, 0.07));
        const wires = mul(hp(noise(n, 21), sr, 1800), env(n, sr, 0.12), 0.9);
        const crack = mul(bp(noise(n, 22), sr, 2000, 6000), env(n, sr, 0.015), 0.9);
        return finish(room(sat(add(shell, wires, crack), 2.2), sr, 0.028, 0.22, 0.05), sr);
      },
    },
    {
      id: "hat",
      name: "Hat closed",
      short: "Hat",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.18, sr);
        const metal = gain(add(...[3100, 4300, 5700, 7900, 9300].map((f) => square(n, sr, f))), 0.1);
        return finish(mul(hp(add(metal, gain(noise(n, 31), 0.7)), sr, 6500, 2), env(n, sr, 0.028)), sr, 0.8);
      },
    },
    {
      id: "ohat",
      name: "Hat open",
      short: "Open",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.6, sr);
        const metal = gain(add(...[3100, 4300, 5700, 7900, 9300].map((f) => square(n, sr, f))), 0.1);
        return finish(mul(hp(add(metal, gain(noise(n, 41), 0.7)), sr, 6000, 2), env(n, sr, 0.2)), sr, 0.8);
      },
    },
    {
      id: "clap",
      name: "Clap",
      short: "Clap",
      level: 0.55,
      render: (sr) => {
        const n = secs(0.5, sr);
        const x = clapBursts(n, sr, 51, [0, 0.009, 0.019, 0.031], 0.01, 0.16, 900, 5000);
        return finish(room(sat(x, 1.8), sr, 0.035, 0.3, 0.07), sr);
      },
    },
    {
      id: "rim",
      name: "Rimshot",
      short: "Rim",
      level: 0.5,
      render: (sr) => {
        const n = secs(0.2, sr);
        const tone = mul(add(gain(sine(n, sr, 1700), 0.5), gain(sine(n, sr, 480), 0.5)), env(n, sr, 0.012));
        const click = mul(bp(noise(n, 61), sr, 1500, 5000), env(n, sr, 0.006), 0.8);
        return finish(sat(add(tone, click), 2), sr);
      },
    },
    {
      id: "tom",
      name: "Tom",
      short: "Tom",
      level: 0.65,
      render: (sr) => {
        const n = secs(0.5, sr);
        const x = add(mul(sweep(n, sr, 220, 115, 0.06), env(n, sr, 0.14)), mul(hp(noise(n, 71), sr, 1500), env(n, sr, 0.006), 0.4));
        return finish(room(sat(x, 1.8), sr, 0.03, 0.18, 0.05), sr);
      },
    },
    {
      id: "cowbell",
      name: "Cowbell",
      short: "Bell",
      level: 0.35,
      render: (sr) => {
        const n = secs(0.4, sr);
        const x = gain(add(square(n, sr, 587), square(n, sr, 845)), 0.5);
        return finish(mul(bp(x, sr, 400, 3000), env(n, sr, 0.09)), sr, 0.8);
      },
    },
  ],
};

// ---------------------------------------------------------------- Kit: "Trap 808" (long subs, crisp tops)

function eight08(sr: number, fHit: number, seed: number, dist = false): Float32Array {
  const n = secs(1.4, sr);
  const f0 = 110,
    glide = 0.03;
  const body = add(sweep(n, sr, f0, fHit, glide), gain(sweep(n, sr, f0, fHit, glide, 2), 0.15));
  const shaped = mul(body, env(n, sr, 0.55, 0.05));
  const click = mul(hp(noise(n, seed), sr, 3000), env(n, sr, 0.002), 0.3);
  let x = sat(add(shaped, click), 1.4);
  if (dist) x = add(gain(sat(hp(x, sr, 30), 5), 0.9), gain(lp(x, sr, 120), 0.5));
  return finish(x, sr, 0.9, 30);
}

const trap808: KitDef = {
  id: "trap808",
  name: "Trap 808",
  blurb: "Gliding 808 subs, snappy snare, bright hats. Trap and drill.",
  drums: [
    { id: "808c", name: "808 C", short: "808 C", level: 0.75, render: (sr) => eight08(sr, 32.7, 101) },
    { id: "808f", name: "808 F", short: "808 F", level: 0.75, render: (sr) => eight08(sr, 43.65, 102) },
    { id: "808d", name: "808 D distorted", short: "808 Dst", level: 0.7, render: (sr) => eight08(sr, 36.7, 103, true) },
    {
      id: "snare",
      name: "Snare",
      short: "Snare",
      level: 0.7,
      render: (sr) => {
        const n = secs(0.4, sr);
        const body = mul(sine(n, sr, 200), env(n, sr, 0.045), 0.8);
        const crack = mul(bp(noise(n, 111), sr, 2500, 9000), env(n, sr, 0.03));
        const tail = mul(hp(noise(n, 112), sr, 1200), env(n, sr, 0.11), 0.6);
        const clap = gain(clapBursts(n, sr, 113, [0, 0.008, 0.017], 0.012, 0.012, 1000, 4500), 0.5);
        return finish(sat(add(body, crack, tail, clap), 2.4), sr);
      },
    },
    {
      id: "clap",
      name: "Clap",
      short: "Clap",
      level: 0.55,
      render: (sr) => {
        const n = secs(0.45, sr);
        return finish(sat(clapBursts(n, sr, 121, [0, 0.011, 0.022, 0.035], 0.009, 0.13, 1200, 6000), 2), sr);
      },
    },
    {
      id: "hat",
      name: "Hat closed",
      short: "Hat",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.12, sr);
        const x = add(mul(hp(noise(n, 131), sr, 8000, 2), env(n, sr, 0.018)), mul(hp(noise(n, 132), sr, 12000), env(n, sr, 0.006), 0.6));
        return finish(x, sr, 0.85, 3);
      },
    },
    {
      id: "ohat",
      name: "Hat open",
      short: "Open",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.45, sr);
        return finish(mul(hp(noise(n, 141), sr, 7000, 2), env(n, sr, 0.13)), sr, 0.8);
      },
    },
    {
      id: "rim",
      name: "Rimshot",
      short: "Rim",
      level: 0.5,
      render: (sr) => {
        const n = secs(0.15, sr);
        const x = add(mul(sine(n, sr, 2200), env(n, sr, 0.008)), mul(bp(noise(n, 151), sr, 2000, 7000), env(n, sr, 0.004)));
        return finish(sat(x, 2), sr);
      },
    },
    {
      id: "snap",
      name: "Snap",
      short: "Snap",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.2, sr);
        const x = add(mul(bp(noise(n, 161), sr, 1800, 6500, 2), env(n, sr, 0.02)), mul(sine(n, sr, 900), env(n, sr, 0.01), 0.4));
        return finish(x, sr, 0.85);
      },
    },
    {
      id: "perc",
      name: "Pluck perc",
      short: "Perc",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.7, sr);
        const x = add(mul(sweep(n, sr, 1200, 420, 0.02), env(n, sr, 0.12)), mul(hp(noise(n, 171), sr, 4000), env(n, sr, 0.004), 0.5));
        return finish(sat(x, 1.5), sr, 0.8);
      },
    },
  ],
};

export const KITS: KitDef[] = [westside, trap808];

export function findDrum(kitId: string, drumId: string): { kit: KitDef; drum: DrumDef } | null {
  const kit = KITS.find((k) => k.id === kitId);
  const drum = kit?.drums.find((d) => d.id === drumId);
  return kit && drum ? { kit, drum } : null;
}

/** Stable source id for a kit drum, shared by every pad that uses it. */
export const kitSourceId = (kitId: string, drumId: string) => `kit_${kitId}_${drumId}`;

/** Inverse of kitSourceId; null for other source ids. */
export function parseKitSourceId(id: string): { kitId: string; drumId: string } | null {
  const m = /^kit_([^_]+)_(.+)$/.exec(id);
  return m ? { kitId: m[1], drumId: m[2] } : null;
}
