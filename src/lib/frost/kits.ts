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
  /**
   * Pitched instruments only: the MIDI note the sound is rendered at. A hit's own `pitch` counts
   * semitones from here, so one pad plays a whole bassline or melody.
   */
  rootMidi?: number;
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
function sweep(
  n: number,
  sr: number,
  f0: number,
  f1: number,
  tau: number,
  harmonic = 1,
): Float32Array {
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
function clapBursts(
  n: number,
  sr: number,
  seed: number,
  offsets: number[],
  shortDecay: number,
  tailDecay: number,
  lo: number,
  hi: number,
) {
  const out = new Float32Array(n);
  offsets.forEach((off, i) => {
    const k = Math.round(off * sr);
    const burst = mul(
      bp(noise(n - k, seed + i), sr, lo, hi),
      env(n - k, sr, i < offsets.length - 1 ? shortDecay : tailDecay),
    );
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
        const shell = mul(
          add(gain(sine(n, sr, 185), 0.6), gain(sine(n, sr, 330), 0.35)),
          env(n, sr, 0.07),
        );
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
        const metal = gain(
          add(...[3100, 4300, 5700, 7900, 9300].map((f) => square(n, sr, f))),
          0.1,
        );
        return finish(
          mul(hp(add(metal, gain(noise(n, 31), 0.7)), sr, 6500, 2), env(n, sr, 0.028)),
          sr,
          0.8,
        );
      },
    },
    {
      id: "ohat",
      name: "Hat open",
      short: "Open",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.6, sr);
        const metal = gain(
          add(...[3100, 4300, 5700, 7900, 9300].map((f) => square(n, sr, f))),
          0.1,
        );
        return finish(
          mul(hp(add(metal, gain(noise(n, 41), 0.7)), sr, 6000, 2), env(n, sr, 0.2)),
          sr,
          0.8,
        );
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
        const tone = mul(
          add(gain(sine(n, sr, 1700), 0.5), gain(sine(n, sr, 480), 0.5)),
          env(n, sr, 0.012),
        );
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
        const x = add(
          mul(sweep(n, sr, 220, 115, 0.06), env(n, sr, 0.14)),
          mul(hp(noise(n, 71), sr, 1500), env(n, sr, 0.006), 0.4),
        );
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
    {
      id: "808c",
      name: "808 C",
      short: "808 C",
      level: 0.75,
      render: (sr) => eight08(sr, 32.7, 101),
    },
    {
      id: "808f",
      name: "808 F",
      short: "808 F",
      level: 0.75,
      render: (sr) => eight08(sr, 43.65, 102),
    },
    {
      id: "808d",
      name: "808 D distorted",
      short: "808 Dst",
      level: 0.7,
      render: (sr) => eight08(sr, 36.7, 103, true),
    },
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
        return finish(
          sat(clapBursts(n, sr, 121, [0, 0.011, 0.022, 0.035], 0.009, 0.13, 1200, 6000), 2),
          sr,
        );
      },
    },
    {
      id: "hat",
      name: "Hat closed",
      short: "Hat",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.12, sr);
        const x = add(
          mul(hp(noise(n, 131), sr, 8000, 2), env(n, sr, 0.018)),
          mul(hp(noise(n, 132), sr, 12000), env(n, sr, 0.006), 0.6),
        );
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
        const x = add(
          mul(sine(n, sr, 2200), env(n, sr, 0.008)),
          mul(bp(noise(n, 151), sr, 2000, 7000), env(n, sr, 0.004)),
        );
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
        const x = add(
          mul(bp(noise(n, 161), sr, 1800, 6500, 2), env(n, sr, 0.02)),
          mul(sine(n, sr, 900), env(n, sr, 0.01), 0.4),
        );
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
        const x = add(
          mul(sweep(n, sr, 1200, 420, 0.02), env(n, sr, 0.12)),
          mul(hp(noise(n, 171), sr, 4000), env(n, sr, 0.004), 0.5),
        );
        return finish(sat(x, 1.5), sr, 0.8);
      },
    },
  ],
};

// ---------------------------------------------------------------- pitched instruments

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Plucked string (Karplus–Strong): a seeded noise burst circulating in a damped delay line. */
function pluckString(
  sr: number,
  f: number,
  seconds: number,
  seed: number,
  damping: number,
  brightness: number,
): Float32Array {
  const n = secs(seconds, sr);
  const period = Math.max(2, Math.round(sr / f));
  const line = lp(noise(period, seed), sr, brightness);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const j = i % period;
    const v = line[j];
    out[i] = v;
    line[j] = damping * 0.5 * (v + prev);
    prev = v;
  }
  return out;
}

/** Band-limited sawtooth by adding harmonics (clean at bass pitches). */
function saw(n: number, sr: number, f: number): Float32Array {
  const out = new Float32Array(n);
  const harmonics = Math.max(1, Math.floor(sr / 2 / f) - 1);
  for (let k = 1; k <= Math.min(harmonics, 40); k++) {
    const a = 1 / k;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin((2 * Math.PI * f * k * i) / sr);
  }
  return out;
}

/** Attack-then-exponential-decay envelope. */
function adEnv(n: number, sr: number, attack: number, decay: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = t < attack ? t / attack : Math.exp(-(t - attack) / decay);
  }
  return out;
}

/** Two-operator FM electric piano: a bell-like attack that mellows as the modulation fades. */
function fmKeys(sr: number, f: number): Float32Array {
  const n = secs(2.5, sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const index = 0.4 + 2.2 * Math.exp(-t / 0.25);
    out[i] =
      Math.sin(2 * Math.PI * f * t + index * Math.sin(2 * Math.PI * f * t)) *
      Math.exp(-t / 0.9) *
      Math.min(1, t / 0.003);
  }
  return out;
}

/**
 * Instruments to turn a hummed line into: rendered once at their root note and played at each
 * hit's pitch, classic-sampler style (higher notes are a little shorter, as on an MPC).
 */
const instruments: KitDef = {
  id: "instruments",
  name: "Instruments",
  blurb: "Pitched sounds for hummed basslines and melodies: each hit plays its own note.",
  drums: [
    {
      id: "808",
      name: "808 bass",
      short: "808",
      level: 0.75,
      rootMidi: 24,
      render: (sr) => eight08(sr, hz(24), 201),
    },
    {
      id: "sub",
      name: "Sub bass",
      short: "Sub",
      level: 0.75,
      rootMidi: 36,
      render: (sr) => {
        const n = secs(2.2, sr);
        return finish(sat(mul(sine(n, sr, hz(36)), adEnv(n, sr, 0.008, 1.1)), 1.3), sr, 0.9, 30);
      },
    },
    {
      id: "bassgtr",
      name: "Bass guitar",
      short: "Bass",
      level: 0.7,
      rootMidi: 40,
      render: (sr) =>
        finish(lp(sat(pluckString(sr, hz(40), 2.2, 211, 0.998, 1800), 1.2), sr, 2400), sr, 0.9, 30),
    },
    {
      id: "synthbass",
      name: "Synth bass",
      short: "Synth",
      level: 0.6,
      rootMidi: 36,
      render: (sr) => {
        const n = secs(1.8, sr);
        return finish(
          sat(lp(mul(saw(n, sr, hz(36)), adEnv(n, sr, 0.005, 0.5)), sr, 700, 2), 1.6),
          sr,
          0.9,
          30,
        );
      },
    },
    {
      id: "keys",
      name: "Keys",
      short: "Keys",
      level: 0.55,
      rootMidi: 60,
      render: (sr) => finish(sat(fmKeys(sr, hz(60)), 1.1), sr, 0.85, 30),
    },
    {
      id: "pluck",
      name: "Pluck",
      short: "Pluck",
      level: 0.55,
      rootMidi: 60,
      render: (sr) => finish(pluckString(sr, hz(60), 1.6, 221, 0.994, 6000), sr, 0.85, 30),
    },
  ],
};

// ---------------------------------------------------------------- Metro-style 808s

interface Sub808 {
  /** Seconds the 808 lasts (the file length). */
  len: number;
  /** Amplitude decay time constant (s) after a short hold. */
  decay: number;
  hold: number;
  /** Pitch starts this many times higher and glides down… */
  drop: number;
  /** …with this time constant (s). */
  glide: number;
  /** Second-harmonic level: makes the 808 audible on small speakers. */
  harm: number;
  /** Kick layered on the attack (0 = none). */
  kick: number;
  /** High click on the attack. */
  click: number;
  /** Saturation drive (1 = clean). */
  drive: number;
  /** Extra distortion stage, like a blown speaker (0 = none). */
  grit: number;
  seed: number;
}

/** One trap 808 at C1: a gliding sub, optional kick layer and click, saturation and grit. */
function metro808(sr: number, o: Sub808): Float32Array {
  const n = secs(o.len, sr);
  const f = hz(24);
  const body = add(
    sweep(n, sr, f * o.drop, f, o.glide),
    gain(sweep(n, sr, f * o.drop, f, o.glide, 2), o.harm),
  );
  let x = mul(body, env(n, sr, o.decay, o.hold));
  if (o.kick) x = add(x, mul(sweep(n, sr, 190, 55, 0.025), env(n, sr, 0.07), o.kick));
  if (o.click) x = add(x, mul(hp(noise(n, o.seed), sr, 3000), env(n, sr, 0.0025), o.click));
  x = sat(x, o.drive);
  if (o.grit) x = add(gain(sat(hp(x, sr, 35), o.grit), 0.85), gain(lp(x, sr, 110), 0.55));
  return finish(lp(x, sr, 7000), sr, 0.9, 40);
}

const METRO_808S: [string, Partial<Sub808>][] = [
  // long and clean
  ["Long Clean", { len: 2.8, decay: 1.2, drop: 1.6, glide: 0.03 }],
  ["Deep Sub", { len: 2.6, decay: 1.0, drop: 1.3, glide: 0.02, harm: 0.05 }],
  ["Smooth Glide", { len: 2.8, decay: 1.1, drop: 2.6, glide: 0.07 }],
  ["Warm Long", { len: 2.5, decay: 0.9, drop: 1.8, glide: 0.035, drive: 1.6 }],
  ["Hollow Sub", { len: 2.4, decay: 0.85, drop: 1.4, glide: 0.025, harm: 0.4 }],
  ["Round Long", { len: 2.7, decay: 1.05, drop: 2.0, glide: 0.04, drive: 1.3, harm: 0.2 }],
  // punchy: a kick on the front
  ["Punch", { len: 1.8, decay: 0.6, drop: 2.5, glide: 0.03, kick: 0.7, click: 0.25 }],
  ["Knock", { len: 1.6, decay: 0.5, drop: 3.0, glide: 0.02, kick: 0.9, click: 0.35, drive: 1.8 }],
  [
    "Hard Hitter",
    { len: 2.0, decay: 0.7, drop: 2.8, glide: 0.025, kick: 0.8, click: 0.3, drive: 2.4 },
  ],
  ["Thump", { len: 1.7, decay: 0.55, drop: 2.2, glide: 0.035, kick: 1.0, drive: 1.5 }],
  ["Bounce", { len: 1.4, decay: 0.42, drop: 3.4, glide: 0.018, kick: 0.6, click: 0.2 }],
  ["Slap", { len: 1.5, decay: 0.45, drop: 3.8, glide: 0.015, kick: 0.75, click: 0.5, drive: 2.0 }],
  // distorted
  ["Dirty", { len: 2.2, decay: 0.8, drop: 2.0, glide: 0.03, drive: 3.0 }],
  ["Fuzz", { len: 2.4, decay: 0.9, drop: 1.8, glide: 0.03, drive: 2.0, grit: 4 }],
  ["Crunch", { len: 1.9, decay: 0.65, drop: 2.6, glide: 0.025, drive: 2.5, grit: 3, kick: 0.4 }],
  ["Overdrive", { len: 2.3, decay: 0.85, drop: 2.2, glide: 0.04, drive: 4.0 }],
  ["Blown", { len: 2.0, decay: 0.75, drop: 2.4, glide: 0.03, drive: 3.0, grit: 6 }],
  ["Grit", { len: 2.1, decay: 0.7, drop: 1.9, glide: 0.035, drive: 2.2, grit: 2.5, harm: 0.3 }],
  // dark sliding tails
  ["Dark Slide", { len: 2.9, decay: 1.3, drop: 3.5, glide: 0.12 }],
  ["Midnight", { len: 2.8, decay: 1.2, drop: 2.8, glide: 0.09, harm: 0.05 }],
  ["Haunt", { len: 2.9, decay: 1.25, drop: 4.0, glide: 0.15, drive: 1.4 }],
  ["Cavern", { len: 2.7, decay: 1.1, drop: 2.4, glide: 0.1, harm: 0.08, drive: 1.2 }],
  ["Night Drive", { len: 2.8, decay: 1.15, drop: 3.0, glide: 0.11, drive: 2.0 }],
  ["Phantom", { len: 2.9, decay: 1.3, drop: 3.2, glide: 0.13, harm: 0.25 }],
  // short and tight
  ["Tight", { len: 0.9, decay: 0.25, drop: 2.5, glide: 0.02, kick: 0.5 }],
  ["Short Bounce", { len: 0.8, decay: 0.22, drop: 3.0, glide: 0.018, kick: 0.6, click: 0.2 }],
  ["Pluck", { len: 0.7, decay: 0.18, drop: 4.0, glide: 0.012, click: 0.4 }],
  ["Stab", { len: 0.6, decay: 0.15, drop: 2.2, glide: 0.02, drive: 2.5, kick: 0.5 }],
  ["Click Short", { len: 0.8, decay: 0.24, drop: 2.0, glide: 0.025, click: 0.7 }],
  ["Rubber", { len: 1.0, decay: 0.3, drop: 3.6, glide: 0.04, harm: 0.35 }],
];

const metro808s: KitDef = {
  id: "metro808",
  name: "Metro-style 808s",
  blurb:
    "30 trap 808s, all tuned to C1: long, punchy, distorted, sliding, short. Play them as notes.",
  drums: METRO_808S.map(([name, o], i) => ({
    id: `m${String(i + 1).padStart(2, "0")}`,
    name: `808 ${String(i + 1).padStart(2, "0")} ${name}`,
    short: `808 ${i + 1}`,
    level: 0.75,
    rootMidi: 24,
    render: (sr: number) =>
      metro808(sr, {
        len: 2,
        decay: 0.8,
        hold: 0.04,
        drop: 2,
        glide: 0.03,
        harm: 0.15,
        kick: 0,
        click: 0.12,
        drive: 1.3,
        grit: 0,
        seed: 300 + i,
        ...o,
      }),
  })),
};

// ---------------------------------------------------------------- Dre-style kicks

interface KickSpec {
  len: number;
  /** Body: pitch sweep from `f0` down to `f1` Hz with time constant `tau`, decaying over `decay`. */
  f0: number;
  f1: number;
  tau: number;
  decay: number;
  /** Beater click: band-passed noise centred around `clickHz`. */
  click: number;
  clickHz: number;
  /** Low "thud" noise under the body. */
  thud: number;
  drive: number;
  /** Top-end roll-off (dusty / vinyl kicks sit lower). */
  top: number;
  /** Short room (0 = dry). */
  room: number;
  seed: number;
}

/** A West Coast kick: punchy round body, beater click, tape-style saturation, optional room. */
function dreKick(sr: number, k: KickSpec): Float32Array {
  const n = secs(k.len, sr);
  const body = mul(sweep(n, sr, k.f0, k.f1, k.tau), env(n, sr, k.decay), 1.1);
  const click = mul(
    bp(noise(n, k.seed), sr, k.clickHz * 0.6, k.clickHz * 1.6),
    env(n, sr, 0.004),
    k.click,
  );
  const thud = mul(lp(noise(n, k.seed + 1), sr, 180), env(n, sr, 0.03), k.thud);
  let x = lp(sat(add(body, click, thud), k.drive), sr, k.top);
  if (k.room) x = room(x, sr, 0.6, k.room, 0.25);
  return finish(x, sr, 0.9, 6);
}

const DRE_KICKS: [string, Partial<KickSpec>][] = [
  ["Hard Knock", { f0: 190, f1: 55, tau: 0.03, decay: 0.2, click: 0.6, clickHz: 2500, drive: 2.6 }],
  ["Studio Thud", { f0: 150, f1: 52, tau: 0.035, decay: 0.24, click: 0.3, thud: 0.5, drive: 2.0 }],
  ["Round", { f0: 140, f1: 50, tau: 0.04, decay: 0.3, click: 0.2, drive: 1.6 }],
  [
    "Punch Tight",
    { f0: 200, f1: 60, tau: 0.022, decay: 0.14, click: 0.55, clickHz: 3000, drive: 2.4 },
  ],
  ["Low Boom", { f0: 120, f1: 45, tau: 0.05, decay: 0.36, click: 0.15, drive: 1.8, len: 0.7 }],
  ["Snappy", { f0: 220, f1: 62, tau: 0.018, decay: 0.12, click: 0.75, clickHz: 3500, drive: 2.2 }],
  ["Dusty", { f0: 160, f1: 54, tau: 0.03, decay: 0.22, click: 0.4, drive: 2.8, top: 4500 }],
  [
    "Vinyl",
    { f0: 150, f1: 50, tau: 0.035, decay: 0.26, click: 0.35, thud: 0.3, drive: 2.4, top: 3800 },
  ],
  ["Fat", { f0: 170, f1: 48, tau: 0.04, decay: 0.32, click: 0.3, thud: 0.4, drive: 3.0 }],
  ["Classic", { f0: 175, f1: 56, tau: 0.028, decay: 0.2, click: 0.5, clickHz: 2200, drive: 2.0 }],
  ["Deep Pocket", { f0: 130, f1: 47, tau: 0.045, decay: 0.34, click: 0.25, drive: 2.0, len: 0.7 }],
  ["Slam", { f0: 210, f1: 58, tau: 0.025, decay: 0.18, click: 0.65, thud: 0.4, drive: 3.4 }],
  ["Warm", { f0: 145, f1: 53, tau: 0.035, decay: 0.25, click: 0.2, drive: 1.5, top: 6000 }],
  ["Room Kick", { f0: 165, f1: 54, tau: 0.03, decay: 0.2, click: 0.45, drive: 2.2, room: 0.25 }],
  [
    "Big Room",
    { f0: 155, f1: 50, tau: 0.035, decay: 0.24, click: 0.4, drive: 2.0, room: 0.4, len: 0.7 },
  ],
  ["Gritty", { f0: 185, f1: 57, tau: 0.026, decay: 0.19, click: 0.5, drive: 4.0, top: 7000 }],
  ["Soft Thump", { f0: 125, f1: 50, tau: 0.04, decay: 0.22, click: 0.1, thud: 0.6, drive: 1.4 }],
  ["Bump", { f0: 180, f1: 60, tau: 0.03, decay: 0.16, click: 0.45, clickHz: 1800, drive: 2.3 }],
  [
    "Heavy",
    { f0: 200, f1: 46, tau: 0.04, decay: 0.3, click: 0.5, thud: 0.5, drive: 3.2, len: 0.7 },
  ],
  [
    "West Coast",
    {
      f0: 170,
      f1: 55,
      tau: 0.03,
      decay: 0.21,
      click: 0.55,
      clickHz: 2600,
      thud: 0.25,
      drive: 2.5,
      room: 0.15,
    },
  ],
];

const dreKicks: KitDef = {
  id: "drekicks",
  name: "Dre-style kicks",
  blurb: "20 punchy, round West Coast kicks — tight, dusty, roomy, heavy.",
  drums: DRE_KICKS.map(([name, k], i) => ({
    id: `k${String(i + 1).padStart(2, "0")}`,
    name: `Kick ${String(i + 1).padStart(2, "0")} ${name}`,
    short: `Kick ${i + 1}`,
    level: 0.8,
    render: (sr: number) =>
      dreKick(sr, {
        len: 0.55,
        f0: 170,
        f1: 54,
        tau: 0.03,
        decay: 0.22,
        click: 0.4,
        clickHz: 2500,
        thud: 0,
        drive: 2.2,
        top: 9000,
        room: 0,
        seed: 400 + i * 3,
        ...k,
      }),
  })),
};

// ---------------------------------------------------------------- Kit: "Metro-style drums" (trap percussion: hats, snares, claps, perc, FX)

/** Reverse a hit so it swells into its end (reverse cymbals). */
function reverseOf(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[x.length - 1 - i];
  return out;
}

/** Metallic hat body: inharmonic square partials (ride/hat bell), plus noise, high-passed. */
function hatBody(
  n: number,
  sr: number,
  seed: number,
  partials: number[],
  metal: number,
  noiseAmt: number,
  hpHz: number,
  order = 2,
): Float32Array {
  const m = gain(add(...partials.map((f) => square(n, sr, f))), metal / partials.length);
  return hp(add(m, gain(noise(n, seed), noiseAmt)), sr, hpHz, order);
}

interface HatSpec {
  len: number;
  decay: number;
  /** Second, faster decay layered in for a sharper tick (0 = none). */
  tick: number;
  partials: number[];
  metal: number;
  noise: number;
  hp: number;
  /** Low-pass to darken (0 = none). */
  lp: number;
  seed: number;
}
function closedHat(sr: number, h: HatSpec): Float32Array {
  const n = secs(h.len, sr);
  let x = mul(hatBody(n, sr, h.seed, h.partials, h.metal, h.noise, h.hp), env(n, sr, h.decay));
  if (h.tick) x = add(x, mul(hp(noise(n, h.seed + 7), sr, 9000, 2), env(n, sr, h.tick), 0.7));
  if (h.lp) x = lp(x, sr, h.lp);
  return finish(x, sr, 0.85, 3);
}

interface SnareSpec {
  len: number;
  /** Shell tone frequencies and their decay. */
  tones: number[];
  toneDecay: number;
  toneAmt: number;
  /** Snare wires: high-passed noise. */
  wireHp: number;
  wireDecay: number;
  wireAmt: number;
  /** Crack: band-passed noise, very short. */
  crack: number;
  /** Clap layer bursts (seconds), empty for none. */
  clap: number[];
  clapAmt: number;
  drive: number;
  room: number;
  roomSize: number;
  roomDecay: number;
  /** Low-pass for a dusty top (0 = none). */
  lp: number;
  /** Bit-crush-ish grit: quantise to 2^bits levels (0 = none). */
  bits: number;
  seed: number;
}
function trapSnare(sr: number, o: SnareSpec): Float32Array {
  const n = secs(o.len, sr);
  const tone = mul(
    gain(add(...o.tones.map((f) => sine(n, sr, f))), o.toneAmt / o.tones.length),
    env(n, sr, o.toneDecay),
  );
  const wires = mul(hp(noise(n, o.seed), sr, o.wireHp), env(n, sr, o.wireDecay), o.wireAmt);
  const crack = mul(bp(noise(n, o.seed + 1), sr, 2500, 9000), env(n, sr, 0.018), o.crack);
  let x = add(tone, wires, crack);
  if (o.clap.length)
    x = add(x, gain(clapBursts(n, sr, o.seed + 2, o.clap, 0.011, 0.09, 1000, 5000), o.clapAmt));
  x = sat(x, o.drive);
  if (o.bits) {
    const q = Math.pow(2, o.bits);
    x = x.map((v) => Math.round(v * q) / q);
  }
  if (o.lp) x = lp(x, sr, o.lp);
  if (o.room) x = room(x, sr, o.roomSize, o.room, o.roomDecay);
  return finish(x, sr);
}

const SNARE_BASE: SnareSpec = {
  len: 0.42,
  tones: [195, 330],
  toneDecay: 0.045,
  toneAmt: 0.8,
  wireHp: 1500,
  wireDecay: 0.1,
  wireAmt: 0.7,
  crack: 1,
  clap: [],
  clapAmt: 0,
  drive: 2.4,
  room: 0,
  roomSize: 0.03,
  roomDecay: 0.05,
  lp: 0,
  bits: 0,
  seed: 900,
};

const METRO_HATS: [string, string, Partial<HatSpec>][] = [
  ["hat1", "Hat tight", { len: 0.1, decay: 0.02, tick: 0.004 }],
  ["hat2", "Hat crisp", { len: 0.14, decay: 0.03, tick: 0.006, metal: 0.4, hp: 9000 }],
  [
    "hat3",
    "Hat dark",
    { len: 0.16, decay: 0.045, tick: 0, metal: 0.7, noise: 0.5, hp: 5000, lp: 9000 },
  ],
  [
    "hat4",
    "Hat bright",
    { len: 0.18, decay: 0.05, tick: 0.005, metal: 0.3, noise: 0.9, hp: 10000 },
  ],
  ["hat5", "Hat ticky", { len: 0.09, decay: 0.012, tick: 0.003, metal: 0.2, hp: 11000 }],
  [
    "hat6",
    "Hat shaker",
    { len: 0.2, decay: 0.08, tick: 0, metal: 0, noise: 1, hp: 6000, lp: 12000 },
  ],
];

const metroDrums: KitDef = {
  id: "metrodrums",
  name: "Metro-style drums",
  blurb:
    "Trap percussion: six hats, two open hats, six snares, three claps, rim, snap, percs, shaker, reverse cymbal, crash.",
  drums: [
    ...METRO_HATS.map(([id, name, h], i) => ({
      id,
      name,
      short: name.replace("Hat ", "Hat "),
      level: 0.45,
      render: (sr: number) =>
        closedHat(sr, {
          len: 0.12,
          decay: 0.025,
          tick: 0.004,
          partials: [3300, 4700, 6100, 8300, 9700],
          metal: 0.5,
          noise: 0.7,
          hp: 8000,
          lp: 0,
          seed: 700 + i * 3,
          ...h,
        }),
    })),
    {
      id: "ohat1",
      name: "Open hat short",
      short: "Open S",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.35, sr);
        return finish(
          mul(
            hatBody(n, sr, 731, [3300, 4700, 6100, 8300, 9700], 0.5, 0.7, 7000),
            env(n, sr, 0.09),
          ),
          sr,
          0.8,
        );
      },
    },
    {
      id: "ohat2",
      name: "Open hat long",
      short: "Open L",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.8, sr);
        return finish(
          mul(
            hatBody(n, sr, 741, [3100, 4300, 5700, 7900, 9300], 0.5, 0.7, 6500),
            env(n, sr, 0.25),
          ),
          sr,
          0.8,
        );
      },
    },
    {
      id: "snr1",
      name: "Snare hard",
      short: "Snare H",
      level: 0.75,
      render: (sr) => trapSnare(sr, { ...SNARE_BASE, drive: 3, crack: 1.2, seed: 910 }),
    },
    {
      id: "snr2",
      name: "Snare + clap",
      short: "Snr+Clp",
      level: 0.72,
      render: (sr) =>
        trapSnare(sr, {
          ...SNARE_BASE,
          len: 0.45,
          clap: [0, 0.009, 0.018],
          clapAmt: 0.6,
          wireDecay: 0.12,
          seed: 920,
        }),
    },
    {
      id: "snr3",
      name: "Snare tight crack",
      short: "Snr Tgt",
      level: 0.7,
      render: (sr) =>
        trapSnare(sr, {
          ...SNARE_BASE,
          len: 0.22,
          toneDecay: 0.025,
          wireDecay: 0.04,
          crack: 1.4,
          drive: 2.8,
          seed: 930,
        }),
    },
    {
      id: "snr4",
      name: "Snare roomy",
      short: "Snr Rm",
      level: 0.7,
      render: (sr) =>
        trapSnare(sr, {
          ...SNARE_BASE,
          len: 0.6,
          wireDecay: 0.14,
          room: 0.35,
          roomSize: 0.04,
          roomDecay: 0.09,
          seed: 940,
        }),
    },
    {
      id: "snr5",
      name: "Snare lo-fi",
      short: "Snr LoFi",
      level: 0.7,
      render: (sr) =>
        trapSnare(sr, {
          ...SNARE_BASE,
          len: 0.38,
          lp: 5500,
          bits: 5,
          drive: 3.2,
          wireHp: 900,
          seed: 950,
        }),
    },
    {
      id: "snr6",
      name: "Rim snare",
      short: "RimSnr",
      level: 0.65,
      render: (sr) =>
        trapSnare(sr, {
          ...SNARE_BASE,
          len: 0.3,
          tones: [480, 1700, 230],
          toneDecay: 0.03,
          toneAmt: 1.1,
          wireAmt: 0.35,
          wireDecay: 0.06,
          crack: 0.9,
          drive: 2.6,
          seed: 960,
        }),
    },
    {
      id: "clp1",
      name: "Clap tight",
      short: "Clap T",
      level: 0.55,
      render: (sr) =>
        finish(
          sat(clapBursts(secs(0.3, sr), sr, 970, [0, 0.009, 0.018], 0.008, 0.07, 1300, 6500), 2.2),
          sr,
        ),
    },
    {
      id: "clp2",
      name: "Clap wide",
      short: "Clap W",
      level: 0.55,
      render: (sr) =>
        finish(
          sat(
            clapBursts(
              secs(0.5, sr),
              sr,
              980,
              [0, 0.012, 0.023, 0.034, 0.047],
              0.012,
              0.14,
              900,
              5500,
            ),
            2,
          ),
          sr,
        ),
    },
    {
      id: "clp3",
      name: "Clap reverb",
      short: "Clap Rv",
      level: 0.5,
      render: (sr) => {
        const n = secs(0.9, sr);
        const x = sat(clapBursts(n, sr, 990, [0, 0.011, 0.022, 0.033], 0.01, 0.12, 1000, 6000), 2);
        const tail = mul(bp(noise(n, 991), sr, 800, 7000), env(n, sr, 0.28, 0.03), 0.35);
        return finish(add(x, tail), sr);
      },
    },
    {
      id: "rim",
      name: "Rimshot",
      short: "Rim",
      level: 0.5,
      render: (sr) => {
        const n = secs(0.14, sr);
        const x = add(
          mul(add(gain(sine(n, sr, 1900), 0.5), gain(sine(n, sr, 520), 0.5)), env(n, sr, 0.01)),
          mul(bp(noise(n, 1001), sr, 1800, 6500), env(n, sr, 0.005), 0.8),
        );
        return finish(sat(x, 2.2), sr);
      },
    },
    {
      id: "snap",
      name: "Snap",
      short: "Snap",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.2, sr);
        const x = add(
          mul(bp(noise(n, 1011), sr, 1800, 7000, 2), env(n, sr, 0.018)),
          mul(sine(n, sr, 950), env(n, sr, 0.009), 0.4),
        );
        return finish(x, sr, 0.85);
      },
    },
    {
      id: "perc1",
      name: "Perc pluck",
      short: "Pluck",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.5, sr);
        const x = add(
          mul(sweep(n, sr, 1400, 520, 0.015), env(n, sr, 0.09)),
          mul(hp(noise(n, 1021), sr, 4000), env(n, sr, 0.003), 0.5),
        );
        return finish(sat(x, 1.5), sr, 0.8);
      },
    },
    {
      id: "perc2",
      name: "Perc wood",
      short: "Wood",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.18, sr);
        const x = add(
          mul(add(sine(n, sr, 820), gain(sine(n, sr, 1230), 0.5)), env(n, sr, 0.018)),
          mul(bp(noise(n, 1031), sr, 1500, 5000), env(n, sr, 0.004), 0.6),
        );
        return finish(sat(x, 1.8), sr, 0.8);
      },
    },
    {
      id: "shaker",
      name: "Shaker",
      short: "Shaker",
      level: 0.35,
      render: (sr) => {
        const n = secs(0.22, sr);
        const e = env(n, sr, 0.06);
        for (let i = 0; i < n; i++) e[i] *= Math.min(1, i / (0.012 * sr)); // soft attack, like a shake
        return finish(mul(bp(noise(n, 1041), sr, 4000, 13000, 2), e), sr, 0.8);
      },
    },
    {
      id: "revcym",
      name: "Reverse cymbal",
      short: "RevCym",
      level: 0.45,
      render: (sr) => {
        // ~1 bar at 140 BPM (1.7 s): a cymbal played backwards, swelling into its end
        const n = secs(1.7, sr);
        const cym = mul(
          hatBody(n, sr, 1051, [2900, 4100, 5300, 7700, 9900, 12300], 0.6, 0.8, 4000, 1),
          env(n, sr, 0.55),
        );
        return finish(reverseOf(cym), sr, 0.85, 8);
      },
    },
    {
      id: "crash",
      name: "Crash impact",
      short: "Crash",
      level: 0.5,
      render: (sr) => {
        const n = secs(1.6, sr);
        const cym = mul(
          hatBody(n, sr, 1061, [2700, 3900, 5100, 7300, 9500, 11700], 0.6, 0.9, 3500, 1),
          env(n, sr, 0.5),
        );
        const boom = mul(sweep(n, sr, 160, 50, 0.04), env(n, sr, 0.25), 0.8);
        return finish(sat(add(cym, boom), 1.6), sr, 0.9, 20);
      },
    },
  ],
};

// ---------------------------------------------------------------- Kits: "Keem-style" (scrunched, sliding 808s; knocking kicks; glitchy percussion)

/** Hard clip at ±`ceil` then bring back up: the blown, "scrunched" top of a distorted 808. */
function clip(x: Float32Array, ceil: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-ceil, Math.min(ceil, x[i])) / ceil;
  return out;
}

/** Quantise to 2^bits levels — bit-crushed crunch. */
function crush(x: Float32Array, bits: number): Float32Array {
  const q = Math.pow(2, bits);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.round(x[i] * q) / q;
  return out;
}

/** Keep every `hold`-th sample (sample-rate reduction) — lo-fi aliasing. */
function decimate(x: Float32Array, hold: number): Float32Array {
  const out = new Float32Array(x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) v = x[i];
    out[i] = v;
  }
  return out;
}

interface Keem808 {
  len: number;
  decay: number;
  hold: number;
  /** Pitch starts `drop`× higher and slides down over `glide` s (big slides are the signature). */
  drop: number;
  glide: number;
  harm: number;
  /** Square-wave blend for a blown, buzzy 808 (0 = pure sine). */
  square: number;
  drive: number;
  /** Hard clip ceiling (1 = none; 0.3 = heavily scrunched). */
  clip: number;
  /** Low-pass after the clip (keeps the scrunch dark). */
  lp: number;
  /** Bit-crush (0 = none). */
  bits: number;
  /** Kick knock layered on the attack. */
  knock: number;
  click: number;
  seed: number;
}
function keem808(sr: number, o: Keem808): Float32Array {
  const n = secs(o.len, sr);
  const f = hz(24);
  const f0 = f * o.drop;
  let body = add(sweep(n, sr, f0, f, o.glide), gain(sweep(n, sr, f0, f, o.glide, 2), o.harm));
  if (o.square) {
    // a square that slides with the sine: sign of the same sweep
    const sq = sweep(n, sr, f0, f, o.glide).map((v) => (v >= 0 ? 1 : -1));
    body = add(gain(body, 1 - o.square), gain(sq, o.square));
  }
  let x = mul(body, env(n, sr, o.decay, o.hold));
  if (o.knock) x = add(x, mul(sweep(n, sr, 210, 60, 0.02), env(n, sr, 0.06), o.knock));
  if (o.click) x = add(x, mul(hp(noise(n, o.seed), sr, 3500), env(n, sr, 0.002), o.click));
  x = sat(x, o.drive);
  if (o.clip < 1) x = clip(x, o.clip);
  if (o.bits) x = crush(x, o.bits);
  x = lp(x, sr, o.lp);
  return finish(x, sr, 0.9, 40);
}

const KEEM_808S: [string, Partial<Keem808>][] = [
  ["Scrunch", { clip: 0.35, lp: 1800, drive: 2.5, drop: 2.2, glide: 0.06 }],
  ["Big Slide", { drop: 4, glide: 0.14, decay: 1.1, clip: 0.6, lp: 3000 }],
  ["Blown Square", { square: 0.6, clip: 0.5, lp: 2200, drive: 2 }],
  ["Knock 808", { knock: 1.2, decay: 0.5, len: 1.4, clip: 0.7, lp: 4000 }],
  ["Crushed", { bits: 4, clip: 0.5, lp: 2600, decay: 0.9 }],
  ["Short Stab", { len: 0.6, decay: 0.18, hold: 0.02, drop: 3, glide: 0.04, clip: 0.45, lp: 2400 }],
  ["Clean Sub", { drive: 1.1, clip: 1, lp: 400, harm: 0.05, decay: 1.2 }],
  ["Glide Up", { drop: 0.5, glide: 0.1, clip: 0.55, lp: 2800 }],
  ["Growl", { square: 0.35, drive: 3.5, clip: 0.3, lp: 1500, harm: 0.3 }],
  ["Long Drag", { len: 3, decay: 1.5, drop: 2.8, glide: 0.2, clip: 0.6, lp: 2500 }],
];

const keem808s: KitDef = {
  id: "keem808",
  name: "Keem-style 808s",
  blurb:
    "10 scrunched, hard-clipped, sliding 808s tuned to C1 — blown squares, crushed, big drags. Play them as notes.",
  drums: KEEM_808S.map(([name, o], i) => ({
    id: `k${String(i + 1).padStart(2, "0")}`,
    name: `808 ${String(i + 1).padStart(2, "0")} ${name}`,
    short: `K808 ${i + 1}`,
    level: 0.72,
    rootMidi: 24,
    render: (sr: number) =>
      keem808(sr, {
        len: 2,
        decay: 0.8,
        hold: 0.04,
        drop: 2,
        glide: 0.05,
        harm: 0.2,
        square: 0,
        drive: 1.8,
        clip: 0.5,
        lp: 2500,
        bits: 0,
        knock: 0,
        click: 0.15,
        seed: 1200 + i,
        ...o,
      }),
  })),
};

/** Short pitched blip: a fast up- or down-sweep — chirps, zips, lasers. */
function zap(
  sr: number,
  len: number,
  f0: number,
  f1: number,
  tau: number,
  decay: number,
  drive: number,
  seed: number,
  noiseAmt = 0,
): Float32Array {
  const n = secs(len, sr);
  let x = mul(sweep(n, sr, f0, f1, tau), env(n, sr, decay));
  if (noiseAmt) x = add(x, mul(hp(noise(n, seed), sr, 3000), env(n, sr, decay * 0.5), noiseAmt));
  return finish(sat(x, drive), sr, 0.85);
}

/** A tiny repeated burst (stutter / glitch). */
function stutter(
  sr: number,
  reps: number,
  gapMs: number,
  make: (n: number) => Float32Array,
): Float32Array {
  const gap = Math.round((gapMs / 1000) * sr);
  const one = make(gap);
  const out = new Float32Array(gap * reps + secs(0.05, sr));
  for (let r = 0; r < reps; r++)
    for (let i = 0; i < one.length; i++) out[r * gap + i] += one[i] * (1 - r * 0.15);
  return finish(out, sr, 0.85);
}

const keemDrums: KitDef = {
  id: "keemdrums",
  name: "Keem-style drums",
  blurb:
    "Knocking, crushed kicks and off-kilter percussion: clicks, pops, wood, bells, chirps, zips, stutters, a vowel blip.",
  drums: [
    // ---- kicks
    {
      id: "kick1",
      name: "Kick knock",
      short: "Knock",
      level: 0.8,
      render: (sr) =>
        dreKick(sr, {
          len: 0.4,
          f0: 230,
          f1: 58,
          tau: 0.018,
          decay: 0.12,
          click: 0.9,
          clickHz: 3200,
          thud: 0.3,
          drive: 3,
          top: 6000,
          room: 0,
          seed: 1301,
        }),
    },
    {
      id: "kick2",
      name: "Kick boxy",
      short: "Boxy",
      level: 0.78,
      render: (sr) =>
        finish(
          lp(
            dreKick(sr, {
              len: 0.3,
              f0: 180,
              f1: 70,
              tau: 0.02,
              decay: 0.08,
              click: 0.5,
              clickHz: 1800,
              thud: 0.6,
              drive: 2.4,
              top: 3000,
              room: 0.15,
              seed: 1302,
            }),
            sr,
            2500,
          ),
          sr,
        ),
    },
    {
      id: "kick3",
      name: "Kick distorted",
      short: "Dist",
      level: 0.75,
      render: (sr) =>
        finish(
          clip(
            dreKick(sr, {
              len: 0.45,
              f0: 200,
              f1: 52,
              tau: 0.03,
              decay: 0.2,
              click: 0.6,
              clickHz: 2500,
              thud: 0.2,
              drive: 4,
              top: 7000,
              room: 0,
              seed: 1303,
            }),
            0.4,
          ),
          sr,
        ),
    },
    {
      id: "kick4",
      name: "Kick crushed",
      short: "Crush",
      level: 0.75,
      render: (sr) =>
        finish(
          crush(
            decimate(
              dreKick(sr, {
                len: 0.4,
                f0: 190,
                f1: 56,
                tau: 0.025,
                decay: 0.16,
                click: 0.7,
                clickHz: 2200,
                thud: 0.3,
                drive: 2.5,
                top: 8000,
                room: 0,
                seed: 1304,
              }),
              3,
            ),
            5,
          ),
          sr,
        ),
    },
    {
      id: "kick5",
      name: "Kick boom",
      short: "Boom",
      level: 0.8,
      render: (sr) =>
        dreKick(sr, {
          len: 0.8,
          f0: 150,
          f1: 45,
          tau: 0.05,
          decay: 0.35,
          click: 0.4,
          clickHz: 2000,
          thud: 0.4,
          drive: 2,
          top: 5000,
          room: 0.1,
          seed: 1305,
        }),
    },
    {
      id: "kick6",
      name: "Kick tight",
      short: "Tight",
      level: 0.78,
      render: (sr) =>
        dreKick(sr, {
          len: 0.22,
          f0: 260,
          f1: 65,
          tau: 0.012,
          decay: 0.06,
          click: 1,
          clickHz: 4000,
          thud: 0.1,
          drive: 2.8,
          top: 9000,
          room: 0,
          seed: 1306,
        }),
    },
    // ---- percussion
    {
      id: "click",
      name: "Click",
      short: "Click",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.09, sr);
        return finish(mul(bp(noise(n, 1310), sr, 2500, 9000, 2), env(n, sr, 0.003)), sr, 0.85, 2);
      },
    },
    {
      id: "pop",
      name: "Pop",
      short: "Pop",
      level: 0.5,
      render: (sr) => zap(sr, 0.09, 900, 180, 0.008, 0.02, 2.5, 1311, 0.2),
    },
    {
      id: "woodhi",
      name: "Wood block hi",
      short: "Wood H",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.12, sr);
        const x = add(
          mul(add(sine(n, sr, 1480), gain(sine(n, sr, 2210), 0.4)), env(n, sr, 0.012)),
          mul(bp(noise(n, 1312), sr, 2000, 7000), env(n, sr, 0.003), 0.5),
        );
        return finish(sat(x, 1.8), sr, 0.8);
      },
    },
    {
      id: "woodlo",
      name: "Wood block lo",
      short: "Wood L",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.16, sr);
        const x = add(
          mul(add(sine(n, sr, 740), gain(sine(n, sr, 1110), 0.4)), env(n, sr, 0.02)),
          mul(bp(noise(n, 1313), sr, 1200, 5000), env(n, sr, 0.004), 0.5),
        );
        return finish(sat(x, 1.8), sr, 0.8);
      },
    },
    {
      id: "bell",
      name: "Bell",
      short: "Bell",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.6, sr);
        const x = add(
          mul(sine(n, sr, 1760), env(n, sr, 0.18)),
          mul(sine(n, sr, 1760 * 2.76), env(n, sr, 0.08), 0.5),
          mul(sine(n, sr, 1760 * 5.4), env(n, sr, 0.03), 0.3),
        );
        return finish(x, sr, 0.8);
      },
    },
    {
      id: "chirp",
      name: "Chirp up",
      short: "Chirp",
      level: 0.4,
      render: (sr) => zap(sr, 0.18, 400, 2600, 0.05, 0.06, 1.6, 1314),
    },
    {
      id: "zip",
      name: "Zip down",
      short: "Zip",
      level: 0.4,
      render: (sr) => zap(sr, 0.14, 3200, 300, 0.03, 0.05, 2, 1315, 0.3),
    },
    {
      id: "laser",
      name: "Laser",
      short: "Laser",
      level: 0.35,
      render: (sr) => zap(sr, 0.3, 4000, 120, 0.09, 0.12, 2.5, 1316),
    },
    {
      id: "crhat",
      name: "Hat crushed",
      short: "CrHat",
      level: 0.4,
      render: (sr) => {
        const n = secs(0.1, sr);
        return finish(
          crush(decimate(mul(hp(noise(n, 1317), sr, 7000, 2), env(n, sr, 0.02)), 2), 4),
          sr,
          0.8,
          3,
        );
      },
    },
    {
      id: "stut",
      name: "Stutter",
      short: "Stut",
      level: 0.45,
      render: (sr) =>
        stutter(sr, 3, 28, (g) => mul(bp(noise(g, 1318), sr, 1500, 6000), env(g, sr, 0.006))),
    },
    {
      id: "blip",
      name: "Vowel blip",
      short: "Blip",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.16, sr);
        const src = saw(n, sr, 160);
        const x = add(
          mul(bp(src, sr, 500, 700, 2), env(n, sr, 0.05), 1.2),
          mul(bp(src, sr, 1050, 1300, 2), env(n, sr, 0.04), 0.8),
        );
        return finish(sat(x, 2.2), sr, 0.8);
      },
    },
    {
      id: "tomhi",
      name: "Tom pitched",
      short: "Tom",
      level: 0.55,
      render: (sr) => {
        const n = secs(0.35, sr);
        const x = add(
          mul(sweep(n, sr, 420, 190, 0.05), env(n, sr, 0.1)),
          mul(hp(noise(n, 1319), sr, 2000), env(n, sr, 0.004), 0.4),
        );
        return finish(clip(sat(x, 2), 0.6), sr);
      },
    },
    {
      id: "knockp",
      name: "Knock perc",
      short: "KnockP",
      level: 0.5,
      render: (sr) => {
        const n = secs(0.12, sr);
        const x = add(
          mul(sweep(n, sr, 300, 140, 0.01), env(n, sr, 0.025)),
          mul(bp(noise(n, 1320), sr, 800, 3000), env(n, sr, 0.004), 0.6),
        );
        return finish(sat(x, 2.5), sr, 0.85);
      },
    },
    {
      id: "crsnap",
      name: "Snap crushed",
      short: "CrSnap",
      level: 0.45,
      render: (sr) => {
        const n = secs(0.15, sr);
        const x = add(
          mul(bp(noise(n, 1321), sr, 1800, 7000, 2), env(n, sr, 0.015)),
          mul(sine(n, sr, 900), env(n, sr, 0.008), 0.4),
        );
        return finish(crush(x, 4), sr, 0.85);
      },
    },
  ],
};

export const KITS: KitDef[] = [
  westside,
  trap808,
  metro808s,
  keem808s,
  dreKicks,
  keemDrums,
  metroDrums,
  instruments,
];

/** The pitched instruments (hum → bass / melody). */
export const INSTRUMENTS = instruments;

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
