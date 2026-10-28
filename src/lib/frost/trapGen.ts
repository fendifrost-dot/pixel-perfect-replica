/**
 * Trap drum generator: Metro-style hats, snare + clap, open-hat / perc accents over a pattern.
 * Pure and deterministic for a seed. It only ADDS notes, tagged `gen: TRAP_TAG`, so "Regenerate"
 * replaces exactly what it wrote and never touches the user's hits or the song (backing) pad.
 * Nothing here is tied to a BPM, key, bank or length: it works from bars and 16th steps.
 */
import { kitSourceId } from "./kits";
import { nextEmptyPad } from "./kitActions";
import { FINE_DIV, toFine } from "./timing";
import type { Bank, NoteEvent, Pattern, Project } from "./types";

export const TRAP_TAG = "trap";
/** The Hum session's backing (song) pad — never used for drums, never edited. */
export const BACKING_PAD_ID = "D16";

export type Density = "sparse" | "normal" | "busy";

/** The drums the generator plays, by role → Metro-style drums kit id. */
export const TRAP_ROLES = {
  hat: "hat2",
  ohat: "ohat1",
  snare: "snr1",
  clap: "clp1",
  perc: "perc1",
} as const;
export type TrapRole = keyof typeof TRAP_ROLES;
export const TRAP_KIT = "metrodrums";

/** Pad ids for each role. */
export type TrapPads = Record<TrapRole, string>;

/**
 * Part of the song with its own feel. Bars are 0-based and `endBar` is exclusive.
 * `offsetSteps` shifts every generated hit (−8..8 steps, fractional to 1/6): a section whose
 * groove lands on the "&" is +2. `skip` leaves the section without drums (an interlude).
 */
export interface TrapSection {
  startBar: number;
  endBar: number;
  offsetSteps: number;
  density: Density;
  skip?: boolean;
}

export interface TrapOptions {
  sections: TrapSection[];
  seed: number;
  pads: TrapPads;
  makeId: () => string;
}

/** Deterministic PRNG (mulberry32), same family the kits use. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEPS_PER_BAR = 16;
const clampVel = (v: number) => Math.max(1, Math.min(127, Math.round(v)));

/** One section covering the whole pattern, straight, at `density`. */
export function wholeSection(pat: Pattern, density: Density = "normal"): TrapSection {
  return {
    startBar: 0,
    endBar: Math.max(1, Math.ceil(pat.lengthSteps / STEPS_PER_BAR)),
    offsetSteps: 0,
    density,
  };
}

/** Sections sanitised: in range, non-overlapping, offsets on the fine grid, in order. */
export function normaliseSections(sections: TrapSection[], totalBars: number): TrapSection[] {
  return sections
    .map((s) => ({
      ...s,
      startBar: Math.max(0, Math.min(totalBars, Math.floor(s.startBar))),
      endBar: Math.max(0, Math.min(totalBars, Math.ceil(s.endBar))),
      offsetSteps: toFine(Math.max(-8, Math.min(8, s.offsetSteps))),
    }))
    .filter((s) => s.endBar > s.startBar)
    .sort((a, b) => a.startBar - b.startBar)
    .reduce<TrapSection[]>((acc, s) => {
      const prev = acc[acc.length - 1];
      if (prev && s.startBar < prev.endBar) s = { ...s, startBar: prev.endBar };
      if (s.endBar > s.startBar) acc.push(s);
      return acc;
    }, []);
}

const DENSITY = {
  sparse: {
    fill: 0.12,
    gap: 0.25,
    rollEvery: 4,
    rollChance: 0.6,
    ohat: 0.15,
    perc: 0.1,
    dropOut: false,
    ghosts: false,
  },
  normal: {
    fill: 0.33,
    gap: 0.35,
    rollEvery: 4,
    rollChance: 0.9,
    ohat: 0.3,
    perc: 0.22,
    dropOut: true,
    ghosts: false,
  },
  busy: {
    fill: 0.6,
    gap: 0.3,
    rollEvery: 2,
    rollChance: 1,
    ohat: 0.45,
    perc: 0.35,
    dropOut: true,
    ghosts: true,
  },
} as const;

const ROLL_RATES = [2 / 3, 1 / 2, 1 / 3];

/**
 * The notes the generator adds for `sections` of a pattern `totalSteps` long. Positions are
 * absolute steps in the pattern (section offset applied), on the fine grid; anything that would
 * fall outside the pattern is dropped.
 */
export function generateTrapNotes(totalSteps: number, o: TrapOptions): NoteEvent[] {
  const r = rng(o.seed);
  const human = (v: number, spread = 12) => clampVel(v + (r() * 2 - 1) * spread);
  const out: NoteEvent[] = [];
  const totalBars = Math.max(1, Math.ceil(totalSteps / STEPS_PER_BAR));
  const sections = normaliseSections(o.sections, totalBars);
  const put = (role: TrapRole, step: number, velocity: number, extra: Partial<NoteEvent> = {}) => {
    const at = toFine(step);
    if (at < 0 || at >= totalSteps) return;
    out.push({
      id: o.makeId(),
      padId: o.pads[role],
      step: at,
      velocity: clampVel(velocity),
      offset: 0,
      exact: true,
      gen: TRAP_TAG,
      ...extra,
    });
  };

  for (const sec of sections) {
    if (sec.skip) continue;
    const d = DENSITY[sec.density];
    const nBars = sec.endBar - sec.startBar;
    for (let i = 0; i < nBars; i++) {
      const bar = sec.startBar + i;
      const base = bar * STEPS_PER_BAR + sec.offsetSteps;
      const dropOut = d.dropOut && i % 8 === 0;
      const lastOfSection = i === nBars - 1;
      // --- hats: 1/8 base, 1/16 fills, a gap before the next downbeat, a roll every N bars
      const rollBar = (i + 1) % d.rollEvery === 0 && r() < d.rollChance;
      const rollLen = rollBar ? (r() < 0.5 ? 2 : 4) : 0; // ½ or 1 beat, ending at the bar line
      const rollStart = STEPS_PER_BAR - rollLen;
      const gap = !rollBar && r() < d.gap;
      if (!dropOut) {
        for (let s = 0; s < STEPS_PER_BAR; s++) {
          if (rollBar && s >= rollStart) continue;
          const onEighth = s % 2 === 0;
          if (gap && s >= STEPS_PER_BAR - 2) continue; // breathe before the downbeat
          if (onEighth) put("hat", base + s, human(s % 4 === 0 ? 100 : 88));
          else if (r() < d.fill) put("hat", base + s, human(66));
        }
        if (rollBar) {
          const rate = ROLL_RATES[Math.floor(r() * ROLL_RATES.length)];
          const n = Math.max(2, Math.round(rollLen / rate));
          const pitched = r() < 0.3 ? Math.round((r() < 0.5 ? 1 : -1) * (3 + r() * 9)) : 0;
          for (let k = 0; k < n; k++) {
            const t = k / (n - 1);
            const pitch = Math.round(pitched * t);
            put("hat", base + rollStart + k * rate, 55 + 50 * t, {
              length: rate,
              ...(pitch ? { pitch } : {}),
            });
          }
        }
      }
      // --- snare + clap on beat 3 (half-time)
      put("snare", base + 8, human(118, 6));
      put("clap", base + 8, human(104, 8));
      // ghost / flam pickups into the next bar (busy only; not out of the last bar of a section)
      if (d.ghosts && !lastOfSection && r() < 0.5) {
        const pick = r() < 0.5 ? 15 : 15.5;
        put("snare", base + pick, human(48, 8));
        if (r() < 0.4) put("snare", base + 14.5, human(36, 6));
      }
      // --- open hat / perc accents on offbeats, sparse
      if (r() < d.ohat) put("ohat", base + (r() < 0.6 ? 14 : 6), human(84, 10));
      if (r() < d.perc) {
        const spots = [3, 7, 11, 13];
        put("perc", base + spots[Math.floor(r() * spots.length)], human(74, 10));
      }
    }
  }
  return out.sort((a, b) => a.step - b.step || a.padId.localeCompare(b.padId));
}

/** Pads in `bank` that already hold each role's drum, else null for that role. */
export function existingTrapPads(p: Project, bank: Bank): Partial<TrapPads> {
  const found: Partial<TrapPads> = {};
  for (const role of Object.keys(TRAP_ROLES) as TrapRole[]) {
    const src = kitSourceId(TRAP_KIT, TRAP_ROLES[role]);
    const pad = p.pads.find(
      (x) =>
        x.bank === bank &&
        x.id !== BACKING_PAD_ID &&
        x.sliceId &&
        p.slices.find((s) => s.id === x.sliceId)?.sourceId === src,
    );
    if (pad) found[role] = pad.id;
  }
  return found;
}

/**
 * Which roles still need a pad in `bank`, and the empty pads they would take (first empty pads,
 * in order, never the backing pad). Returns null if the bank cannot fit them.
 */
export function planTrapPads(
  p: Project,
  bank: Bank,
): { pads: TrapPads; toLoad: { role: TrapRole; padId: string }[] } | null {
  const have = existingTrapPads(p, bank);
  const pads = { ...have } as TrapPads;
  const toLoad: { role: TrapRole; padId: string }[] = [];
  let scratch = p;
  for (const role of Object.keys(TRAP_ROLES) as TrapRole[]) {
    if (have[role]) continue;
    let pad = nextEmptyPad(scratch, bank);
    while (pad && pad.id === BACKING_PAD_ID) {
      scratch = {
        ...scratch,
        pads: scratch.pads.map((x) => (x.id === pad!.id ? { ...x, sliceId: "reserved" } : x)),
      };
      pad = nextEmptyPad(scratch, bank);
    }
    if (!pad) return null;
    pads[role] = pad.id;
    toLoad.push({ role, padId: pad.id });
    scratch = {
      ...scratch,
      pads: scratch.pads.map((x) => (x.id === pad!.id ? { ...x, sliceId: "reserved" } : x)),
    };
  }
  return { pads, toLoad };
}

/**
 * Add generated drums to pattern `patternId`: previously generated notes (tag) are replaced,
 * everything else is kept. Lanes are added for the drum pads so they show on Beat. One project
 * update = one undo step.
 */
export function addTrapDrums(p: Project, patternId: string, o: TrapOptions): Project {
  return {
    ...p,
    patterns: p.patterns.map((pt) => {
      if (pt.id !== patternId) return pt;
      const kept = pt.notes.filter((n) => n.gen !== TRAP_TAG);
      const made = generateTrapNotes(pt.lengthSteps, o);
      const lanes = [...pt.lanes];
      for (const id of new Set(made.map((n) => n.padId)))
        if (!lanes.some((l) => l.padId === id)) lanes.push({ padId: id, mute: false, solo: false });
      return { ...pt, lanes, notes: [...kept, ...made] };
    }),
  };
}

/** Remove everything the generator wrote in a pattern. */
export function clearTrapDrums(p: Project, patternId: string): Project {
  return {
    ...p,
    patterns: p.patterns.map((pt) =>
      pt.id !== patternId ? pt : { ...pt, notes: pt.notes.filter((n) => n.gen !== TRAP_TAG) },
    ),
  };
}

export const hasTrapDrums = (pat: Pattern) => pat.notes.some((n) => n.gen === TRAP_TAG);

/** Fine-grid guard used by the UI's offset field. */
export const FINE_STEP = 1 / FINE_DIV;
