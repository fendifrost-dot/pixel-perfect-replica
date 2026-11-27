/**
 * Pure helpers for a zoomable time view: keyboard zoom (the same keys as Pro Tools), zooming around
 * a point, and the grid lines / ruler labels to draw for whatever is on screen.
 */

export type ZoomCommand = "in" | "out" | "all" | "selection";

export interface KeyLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Pro Tools zoom keys:
 *  T / R              zoom in / out (Commands Keyboard Focus)
 *  ⌘] / ⌘[            zoom in / out (Ctrl on Windows)
 *  ⌥A                 show everything
 *  ⌥F                 fill the view with the selection
 * `code` is used for the Option shortcuts because Option changes the typed character on a Mac.
 */
export function zoomCommand(e: KeyLike): ZoomCommand | null {
  const mod = !!(e.metaKey || e.ctrlKey);
  const code = e.code ?? "";
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.altKey && !mod) {
    if (code === "KeyA" || (!code && key === "a")) return "all";
    if (code === "KeyF" || (!code && key === "f")) return "selection";
    return null;
  }
  if (mod && !e.altKey) {
    if (key === "]" || code === "BracketRight") return "in";
    if (key === "[" || code === "BracketLeft") return "out";
    return null;
  }
  if (mod || e.altKey) return null;
  if (key === "t") return "in";
  if (key === "r") return "out";
  return null;
}

/** True when the key press belongs to a text field, so shortcuts must leave it alone. */
export function isTypingTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el.type ?? "text").toLowerCase();
  return !["range", "checkbox", "radio", "button", "submit", "file"].includes(type);
}

/** One zoom step per key press, the same ratio as the on-screen zoom buttons. */
export const ZOOM_STEP = 1.5;

/**
 * Zoom a [start, end] view by `factor` (> 1 zooms in), keeping `anchor` at the same place on screen.
 * The result stays inside [0, duration] and never gets narrower than `minSpan`.
 */
export function zoomView(
  view: readonly [number, number],
  duration: number,
  factor: number,
  anchor?: number,
  minSpan = 0.02,
): [number, number] {
  const [s, e] = view;
  const span = e - s;
  if (!(duration > 0) || !(span > 0) || !(factor > 0)) return [0, Math.max(duration, 0)];
  const lo = Math.min(minSpan, duration);
  const next = Math.min(duration, Math.max(lo, span / factor));
  const a = anchor == null ? (s + e) / 2 : Math.min(e, Math.max(s, anchor));
  const frac = (a - s) / span;
  const start = Math.min(Math.max(0, a - frac * next), duration - next);
  return [start, start + next];
}

/** Where keyboard zoom holds still: the selection start when it is on screen, else the middle. */
export function zoomAnchor(
  view: readonly [number, number],
  selection: { start: number; end: number } | null,
): number {
  if (selection && selection.start >= view[0] && selection.start <= view[1]) return selection.start;
  return (view[0] + view[1]) / 2;
}

/** The view that fills the screen with the selection, with a little air either side. */
export function viewForSelection(
  selection: { start: number; end: number },
  duration: number,
  minSpan = 0.02,
): [number, number] {
  const len = Math.max(selection.end - selection.start, 0);
  const span = Math.min(duration, Math.max(minSpan, len * 1.1));
  const mid = (selection.start + selection.end) / 2;
  const start = Math.min(Math.max(0, mid - span / 2), Math.max(0, duration - span));
  return [start, start + span];
}

export interface GridLine {
  t: number;
  major: boolean;
  /** Ruler text, only on lines that carry one. */
  label?: string;
}

/** Round ruler intervals (seconds) and how many minor divisions each one splits into. */
const TIME_STEPS: readonly (readonly [number, number])[] = [
  [0.001, 5],
  [0.002, 4],
  [0.005, 5],
  [0.01, 5],
  [0.02, 4],
  [0.05, 5],
  [0.1, 5],
  [0.2, 4],
  [0.5, 5],
  [1, 5],
  [2, 4],
  [5, 5],
  [10, 5],
  [15, 3],
  [30, 3],
  [60, 4],
  [120, 4],
  [300, 5],
  [600, 5],
  [1800, 3],
  [3600, 6],
];

/** Clock text for a ruler tick; shows as many decimals as the tick spacing needs. */
export function timeLabel(t: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const whole = Math.floor(t / 60);
  const sec = t - whole * 60;
  const s = sec.toFixed(decimals);
  const padded = decimals ? s.padStart(3 + decimals, "0") : s.padStart(2, "0");
  return `${whole}:${padded}`;
}

/**
 * A clock grid for the visible range: labelled major lines at a round interval at least
 * `minMajorPx` apart, with unlabelled minor lines between them when there is room.
 */
export function timeGrid(
  viewStart: number,
  viewEnd: number,
  widthPx: number,
  minMajorPx = 90,
): GridLine[] {
  const span = viewEnd - viewStart;
  if (!(span > 0) || !(widthPx > 0)) return [];
  const perPx = span / widthPx;
  const [major, parts] =
    TIME_STEPS.find(([s]) => s / perPx >= minMajorPx) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const minor = major / parts;
  const showMinor = minor / perPx >= 8;
  const step = showMinor ? minor : major;
  const out: GridLine[] = [];
  const first = Math.ceil(viewStart / step - 1e-9);
  const last = Math.floor(viewEnd / step + 1e-9);
  for (let i = first; i <= last && out.length < 4000; i++) {
    const t = i * step;
    const isMajor = !showMinor || i % parts === 0;
    out.push(
      isMajor ? { t, major: true, label: timeLabel(Math.max(0, t), major) } : { t, major: false },
    );
  }
  return out;
}

/**
 * A musical grid from placed beat markers (which may have been dragged, so spacing can vary):
 * bars are labelled, beats are minor lines, and beats split into 16ths once there is room. When
 * zoomed far out only every 2nd / 4th / 8th… bar is drawn, so lines never crowd.
 */
export function beatGrid(
  beats: readonly number[],
  viewStart: number,
  viewEnd: number,
  widthPx: number,
  beatsPerBar = 4,
): GridLine[] {
  const span = viewEnd - viewStart;
  if (beats.length < 2 || !(span > 0) || !(widthPx > 0)) return [];
  const pxPer = widthPx / span;
  const avgBeat = (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1);
  const beatPx = avgBeat * pxPer;
  const barPx = beatPx * beatsPerBar;
  let barEvery = 1;
  while (barPx * barEvery < 44 && barEvery < 4096) barEvery *= 2;
  const showBeats = barEvery === 1 && beatPx >= 8;
  const sub = showBeats && beatPx >= 96 ? 4 : showBeats && beatPx >= 48 ? 2 : 1;
  const out: GridLine[] = [];
  for (let i = 0; i < beats.length && out.length < 4000; i++) {
    const t = beats[i]!;
    const next = beats[i + 1];
    if (t > viewEnd) break;
    const isBar = i % beatsPerBar === 0;
    const bar = i / beatsPerBar;
    if (t >= viewStart) {
      if (isBar) {
        if (bar % barEvery === 0) out.push({ t, major: true, label: String(bar + 1) });
      } else if (showBeats) {
        out.push({
          t,
          major: false,
          ...(beatPx >= 34 ? { label: `${Math.floor(bar) + 1}.${(i % beatsPerBar) + 1}` } : {}),
        });
      }
    }
    if (sub > 1 && next != null) {
      for (let k = 1; k < sub; k++) {
        const st = t + ((next - t) * k) / sub;
        if (st >= viewStart && st <= viewEnd) out.push({ t: st, major: false });
      }
    }
  }
  return out;
}

/** The grid to draw: musical when the recording has beat markers, a clock otherwise. */
export function gridLines(
  beats: readonly number[] | null | undefined,
  viewStart: number,
  viewEnd: number,
  widthPx: number,
): GridLine[] {
  return beats && beats.length >= 2
    ? beatGrid(beats, viewStart, viewEnd, widthPx)
    : timeGrid(viewStart, viewEnd, widthPx);
}

/** The next pad after `afterId` in `ids` with no sound, wrapping once; null when all are full. */
export function nextEmptyPad(
  pads: readonly { id: string; sliceId: string | null }[],
  ids: readonly string[],
  afterId: string,
): string | null {
  const at = ids.indexOf(afterId);
  for (let k = 1; k <= ids.length; k++) {
    const id = ids[(Math.max(at, -1) + k) % ids.length]!;
    if (id === afterId) continue;
    const pad = pads.find((p) => p.id === id);
    if (pad && !pad.sliceId) return id;
  }
  return null;
}
