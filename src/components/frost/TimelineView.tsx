import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BoxSelect,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Magnet,
  Maximize,
  Mic,
  Maximize2,
  Minimize2,
  Minus,
  Play,
  Plus,
  Repeat,
  Scissors,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
} from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import { audioStore } from "@/lib/frost/audioStore";
import { playbackService } from "@/lib/frost/engine";
import { waveColumns } from "@/lib/frost/analysis";
import { effectiveStep, playPlan, stepDur, toFine } from "@/lib/frost/timing";
import { ROLL_RATES, applyRoll, rollCount, type VelocityRamp } from "@/lib/frost/roll";
import { TrapDrums } from "./TrapDrums";
import { PATTERN_BARS, songToTimeline, stepsToFit } from "@/lib/frost/ops";
import {
  MAX_PATTERN_BARS,
  type Lane,
  type NoteEvent,
  type Pad,
  type Pattern,
  type Slice,
} from "@/lib/frost/types";
import { Segmented } from "./controls";
import { HumRecorder } from "./HumRecorder";
import { INSTRUMENTS, parseKitSourceId } from "@/lib/frost/kits";
import { assignDrum, pruneKitSources } from "@/lib/frost/kitActions";
import { kitService } from "@/lib/frost/engine";
import { noteName } from "@/lib/frost/hum";
import { cn } from "@/lib/utils";

/**
 * Grid choices in steps (16ths). 1/24 and 1/48 are triplet grids (⅔ and ⅓ step); 1/32 = half a
 * step. The shortest a hit can be dragged to is 1/32; rolls can go down to 1/48.
 */
const SNAPS: { value: number; label: string }[] = [
  { value: 16, label: "Bar" },
  { value: 4, label: "1/4" },
  { value: 2, label: "1/8" },
  { value: 1, label: "1/16" },
  { value: 2 / 3, label: "1/24" },
  { value: 0.5, label: "1/32" },
  { value: 1 / 3, label: "1/48" },
];
/** Roll lengths in steps. */
const ROLL_LENGTHS = [
  { value: 1, label: "¼ beat" },
  { value: 2, label: "½ beat" },
  { value: 4, label: "1 beat" },
  { value: 8, label: "2 beats" },
  { value: 16, label: "1 bar" },
];
const LENGTHS = [
  { value: 0, label: "Full" },
  { value: 0.5, label: "1/32" },
  { value: 1, label: "1/16" },
  { value: 2, label: "1/8" },
  { value: 4, label: "1/4" },
  { value: 8, label: "½ bar" },
  { value: 16, label: "1 bar" },
];
const MIN_LEN = 0.5;
/** Pixels per 16th step: from a whole 128-bar song on screen up to fine 1/32 editing. */
const MIN_PPS = 0.25;
const MAX_PPS = 64;
const clampPps = (v: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, v));
const ROW_H = 44;
const LABEL_W = 84;
const RULER_H = 24;

const BLOCK: Record<Pad["color"], string> = {
  teal: "bg-teal/35 border-teal",
  purple: "bg-purple/35 border-purple",
  amber: "bg-primary/35 border-primary",
};

const waves = new Map<string, string>();
/** A small picture of a chop's waveform, stretched over a hit block at its natural length. */
function waveImage(slice: Slice, reverse: boolean): string | null {
  const key = `${slice.sourceId}|${slice.start}|${slice.end}|${reverse}`;
  const hit = waves.get(key);
  if (hit) return hit;
  const b = audioStore.getBuffer(slice.sourceId);
  if (!b || typeof document === "undefined") return null;
  const W = 240,
    H = 96;
  const cols = waveColumns(
    Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)),
    b.sampleRate,
    slice.start,
    slice.end,
    W,
  );
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,255,255,0.85)";
  for (let x = 0; x < W; x++) {
    const i = reverse ? W - 1 - x : x;
    const lo = cols[i * 2],
      hi = cols[i * 2 + 1];
    g.fillRect(x, H / 2 - hi * (H / 2), 1, Math.max(1, (hi - lo) * (H / 2)));
  }
  const url = c.toDataURL();
  if (waves.size > 200) waves.clear();
  waves.set(key, url);
  return url;
}

/** How long a finger rests on a hit (or empty grid) before its menu opens. */
const HOLD_MS = 450;

/** One copied hit: everything but its id and place; `rel` = steps after the first copied hit. */
type ClipItem = Omit<NoteEvent, "id" | "step" | "offset" | "exact"> & { rel: number };
/** The copied hits — kept outside the component so they survive switching tabs. */
let clipboard: ClipItem[] | null = null;

type Menu = { x: number; y: number; padId: string; step: number; noteId?: string; row?: boolean };

type Drag = {
  id: string;
  kind: "move" | "size" | "group";
  /** Select mode: the hit was already picked when pressed (a plain tap then un-picks it). */
  wasPicked?: boolean;
  x0: number;
  y0: number;
  step0: number;
  len0: number;
  row0: number;
  moved: boolean;
};

/**
 * DAW-style view of one pattern: a row per pad, every hit drawn at its real length with its
 * waveform. Tap the grid to place, drag a hit to move it (also to another row), drag its handle
 * to shorten or lengthen it — down to a 1/32 note. Long patterns (up to 128 bars) hold a whole song.
 */
export function TimelineView({ pat }: { pat: Pattern }) {
  const {
    project,
    commit,
    currentStep,
    playing,
    togglePlay,
    repeat,
    setRepeat,
    notify,
    setLoopMode,
    audioVersion,
  } = useFrost();
  const [clip, setClip] = useState<ClipItem[] | null>(clipboard);
  const [humOpen, setHumOpen] = useState(false);
  /** Select mode: tap hits or drag a box to pick several, then move / copy / repeat them together. */
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [groupDraft, setGroupDraft] = useState<{ dStep: number; dRow: number } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const hold = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
    fired: boolean;
  } | null>(null);
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    if (hold.current && !hold.current.fired) hold.current = null;
  };
  /** Start a press; `open` runs if the finger stays put for HOLD_MS. */
  const startHold = (e: React.PointerEvent, open: () => void) => {
    cancelHold();
    const h = {
      x: e.clientX,
      y: e.clientY,
      fired: false,
      timer: setTimeout(() => {
        h.fired = true;
        window.navigator.vibrate?.(15);
        open();
      }, HOLD_MS),
    };
    hold.current = h;
  };
  const movedHold = (e: React.PointerEvent) => {
    const h = hold.current;
    if (h && !h.fired && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 8) cancelHold();
  };
  /** Copy hits, keeping their spacing (and rows, when more than one). */
  const copyHits = (ns: NoteEvent[], at: (n: NoteEvent) => number) => {
    if (!ns.length) return;
    const s0 = Math.min(...ns.map(at));
    clipboard = ns
      .map(({ id: _id, step: _step, offset: _o, exact: _e, ...rest }) => ({ ...rest, rel: 0 }))
      .map((c, i) => ({ ...c, rel: at(ns[i]) - s0 }));
    setClip(clipboard);
  };
  const copyHit = (n: NoteEvent) => copyHits([n], (x) => blocks.get(x.id)?.at ?? x.step);
  // Sideways on a phone the timeline takes the whole screen (exit returns to the page until turned again).
  const sideways = usePhoneLandscape();
  const [fullDismissed, setFullDismissed] = useState(false);
  const [forceFull, setForceFull] = useState(false);
  useEffect(() => {
    setFullDismissed(false);
    if (!sideways) setForceFull(false);
  }, [sideways]);
  const full = (sideways || forceFull) && !fullDismissed;
  const [snap, setSnap] = useState<number>(1);
  const [pps, setPps] = useState(12);
  const [sel, setSel] = useState<string | null>(null);
  const [trapOpen, setTrapOpen] = useState(false);
  // Roll tool (on the selected hit): settings live here until "Apply", which is one undo step.
  const [rollOpen, setRollOpen] = useState(false);
  const [roll, setRoll] = useState<{
    rate: number;
    length: number;
    vel: VelocityRamp;
    pitch: number;
  }>({ rate: 0.5, length: 4, vel: "up", pitch: 0 });
  const [draft, setDraft] = useState<{
    id: string;
    step: number;
    length: number | undefined;
    padId: string;
  } | null>(null);
  const drag = useRef<Drag | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Scroll position to restore after a zoom renders: keeps the spot under the fingers in place. */
  const pendingScroll = useRef<{ left: number; top?: number } | null>(null);
  const [view, setView] = useState({ left: 0, width: 1, total: 1 });
  const ppsRef = useRef(pps);
  ppsRef.current = pps;
  /** The song's length (where Play stops / loops). */
  const L = pat.lengthSteps;
  /** The grid always runs to the maximum, so a hit can go anywhere; the song grows to reach it. */
  const W = MAX_PATTERN_BARS * 16;
  const sd = stepDur(project.bpm);

  const upd = (fn: (p: Pattern) => Pattern, history = true) =>
    commit(
      (p) => ({
        ...p,
        patterns: p.patterns.map((x) => {
          if (x.id !== pat.id) return x;
          const y = fn(x);
          // A hit placed past the end makes the song longer (never shorter).
          const need = y.notes.reduce((m, n) => Math.max(m, stepsToFit(n.step)), 0);
          return need > y.lengthSteps ? { ...y, lengthSteps: need } : y;
        }),
      }),
      { history },
    );
  const setNote = (
    id: string,
    patch: Omit<Partial<NoteEvent>, "length"> & { length?: number | undefined },
  ) =>
    upd((x) => ({
      ...x,
      notes: x.notes.map((n) => {
        if (n.id !== id) return n;
        const { length, ...rest } = patch;
        const next: NoteEvent = { ...n, ...rest };
        if ("length" in patch) {
          if (length) next.length = length;
          else delete next.length;
        }
        return next;
      }),
    }));

  const padOf = (id: string) => project.pads.find((p) => p.id === id);
  const sliceOf = (pad: Pad | undefined) => project.slices.find((s) => s.id === pad?.sliceId);
  /** Steps a pad's chop lasts at the project tempo (its fit applied). */
  const naturalSteps = (pad: Pad | undefined) => {
    const s = sliceOf(pad);
    return pad && s ? playPlan(pad, s, project.bpm).duration / sd : 1;
  };

  const allRows = project.pads
    .filter(
      (p) =>
        pat.notes.some((n) => n.padId === p.id) ||
        pat.lanes.some((l) => l.padId === p.id) ||
        (p.id === project.selectedPadId && p.sliceId),
    )
    .map((p) => p.id);
  /** Focus: one track blown up to fill the timeline, to see exactly where its hits sit. */
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const rowIds = focusRow && allRows.includes(focusRow) ? [focusRow] : allRows;
  const [boxH, setBoxH] = useState(0);
  // full screen: the grid has a fixed height to fill; upright it grows with its content, so use a set size
  const rowH =
    rowIds.length === 1 && focusRow ? (full ? Math.max(120, boxH - RULER_H - 4) : 260) : ROW_H;
  const addable = project.pads.filter((p) => p.sliceId && !allRows.includes(p.id));
  const laneOf = (padId: string): Lane =>
    pat.lanes.find((l) => l.padId === padId) ?? { padId, mute: false, solo: false };
  const setLane = (padId: string, patch: Partial<Lane>) =>
    upd((x) => ({
      ...x,
      lanes: [...x.lanes.filter((l) => l.padId !== padId), { ...laneOf(padId), ...patch }],
    }));

  /** Where each hit sits and how long it sounds (as playback would), in steps. */
  const blocks = useMemo(() => {
    const out = new Map<string, { at: number; len: number; natural: number }>();
    const byPad = new Map<string, { id: string; at: number }[]>();
    for (const n of pat.notes) {
      const at = effectiveStep(n, project.quantize, 50, L);
      byPad.set(n.padId, [...(byPad.get(n.padId) ?? []), { id: n.id, at }]);
    }
    for (const list of byPad.values()) list.sort((a, b) => a.at - b.at);
    for (const n of pat.notes) {
      const pad = padOf(n.padId);
      const list = byPad.get(n.padId)!;
      const at = list.find((x) => x.id === n.id)!.at;
      const natural = naturalSteps(pad);
      let len = n.length ?? natural;
      if (!n.length && pad && pad.mode !== "oneshot")
        len = (list.find((x) => x.at > at)?.at ?? L) - at;
      // A one-shot rings past the song's end; holds and loops stop there.
      out.set(n.id, {
        at,
        len: Math.min(len, (pad?.mode === "oneshot" || n.length ? W : L) - at),
        natural,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pat, project.quantize, project.pads, project.slices, project.bpm]);

  const hear = (padId: string, pitch = 0) => {
    const base = padOf(padId);
    if (!base) return;
    const pad = pitch ? { ...base, pitch: base.pitch + pitch } : base;
    playbackService.stopAll();
    const go = () => playbackService.triggerPad(pad, sliceOf(pad), pad.velocity, project.bpm);
    if (playbackService.isReady()) go();
    else void playbackService.resume().then((ok) => ok && go());
  };

  // Keep the playhead in view while playing.
  const head = playing && currentStep >= 0 ? currentStep % L : -1;
  useEffect(() => {
    const el = scroller.current;
    if (!el || head < 0 || drag.current) return;
    const x = LABEL_W + head * pps;
    if (x < el.scrollLeft + LABEL_W || x > el.scrollLeft + el.clientWidth - 24)
      el.scrollLeft = x - LABEL_W - 16;
  }, [head, pps]);

  useLayoutEffect(() => {
    const el = scroller.current,
      ps = pendingScroll.current;
    if (!el || !ps) return;
    el.scrollLeft = ps.left;
    if (ps.top != null) el.scrollTop = ps.top;
    pendingScroll.current = null;
    readView();
  });
  const readView = () => {
    const el = scroller.current;
    if (el) setView({ left: el.scrollLeft, width: el.clientWidth, total: el.scrollWidth });
  };
  /** Zoom to `next` pixels per step, keeping the step under `screenX` (px from the scroller's left) still. */
  const zoomTo = (next: number, screenX?: number) => {
    const el = scroller.current;
    const z = clampPps(next);
    if (!el) return setPps(z);
    const fx = screenX ?? (el.clientWidth + LABEL_W) / 2;
    const step = Math.max(0, (el.scrollLeft + fx - LABEL_W) / ppsRef.current);
    pendingScroll.current = { left: Math.max(0, step * z + LABEL_W - fx) };
    setPps(z);
  };
  const fit = () => {
    const el = scroller.current;
    if (el) zoomTo((el.clientWidth - LABEL_W - 4) / L, LABEL_W);
  };

  // Two-finger pinch zooms around the fingers and pans with them; one finger scrolls natively.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let g: { d0: number; pps0: number; step: number; x0: number; y0: number; top0: number } | null =
      null;
    const two = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      const r = el.getBoundingClientRect();
      return {
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        x: (a.clientX + b.clientX) / 2 - r.left,
        y: (a.clientY + b.clientY) / 2,
      };
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      drag.current = null; // a pinch that began on a hit is not a move
      setDraft(null);
      const t = two(e);
      g = {
        d0: Math.max(10, t.d),
        pps0: ppsRef.current,
        step: (el.scrollLeft + t.x - LABEL_W) / ppsRef.current,
        x0: t.x,
        y0: t.y,
        top0: el.scrollTop,
      };
    };
    const move = (e: TouchEvent) => {
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      const t = two(e);
      const z = clampPps(g.pps0 * (t.d / g.d0));
      pendingScroll.current = {
        left: Math.max(0, g.step * z + LABEL_W - t.x),
        top: g.top0 - (t.y - g.y0),
      };
      if (z === ppsRef.current) {
        el.scrollLeft = pendingScroll.current.left;
        el.scrollTop = pendingScroll.current.top!;
        pendingScroll.current = null;
      } else setPps(z);
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) g = null;
    };
    // iOS Safari also reports a pinch as a "gesture" with a scale — used when the touch path above
    // didn't catch it (e.g. a finger already scrolling when the second one landed).
    type Gesture = Event & { scale: number; clientX: number };
    let gs: { pps0: number; step: number; x: number } | null = null;
    const gStart = (e: Event) => {
      e.preventDefault(); // never zoom the whole page
      if (g) return;
      const r = el.getBoundingClientRect();
      const x = ((e as Gesture).clientX ?? r.left + r.width / 2) - r.left;
      gs = { pps0: ppsRef.current, step: (el.scrollLeft + x - LABEL_W) / ppsRef.current, x };
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      if (g || !gs) return;
      const z = clampPps(gs.pps0 * (e as Gesture).scale);
      pendingScroll.current = { left: Math.max(0, gs.step * z + LABEL_W - gs.x) };
      setPps(z);
    };
    const gEnd = (e: Event) => {
      e.preventDefault();
      gs = null;
    };
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("gesturestart", gStart);
    el.addEventListener("gesturechange", gChange);
    el.addEventListener("gestureend", gEnd);
    // the focused track fills whatever height the timeline has
    const ro = new ResizeObserver(() => setBoxH(el.clientHeight));
    ro.observe(el);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("gesturestart", gStart);
      el.removeEventListener("gesturechange", gChange);
      el.removeEventListener("gestureend", gEnd);
      ro.disconnect();
    };
    // Re-attach whenever the grid is rebuilt: going full screen (phone sideways) makes a new one.
  }, [full]);
  useEffect(readView, [pps, L, full]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapTo = (v: number) => toFine(Math.round(v / snap) * snap);
  const snapName = SNAPS.find((x) => x.value === snap)?.label ?? "grid";
  /** Pull hits onto the grid (the current snap): the start moves to the nearest line; length is kept. */
  const quantize = (ids: Iterable<string>) => {
    const set = new Set(ids);
    let moved = 0;
    upd((x) => ({
      ...x,
      notes: x.notes.map((n) => {
        if (!set.has(n.id)) return n;
        const at = blocks.get(n.id)?.at ?? n.step + n.offset;
        const step = Math.max(0, snapTo(at));
        if (Math.abs(step - at) > 1e-6 || n.offset) moved++;
        return { ...n, step, offset: 0, exact: true };
      }),
    }));
    notify(
      moved
        ? `Snapped ${moved} hit${moved === 1 ? "" : "s"} to the ${snapName} grid.`
        : `Already on the ${snapName} grid.`,
    );
  };

  const onBlockDown = (e: React.PointerEvent, n: NoteEvent, kind: Drag["kind"]) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const b = blocks.get(n.id)!;
    if (selectMode && kind === "move") {
      const wasPicked = picked.has(n.id);
      if (!wasPicked) setPicked(new Set([...picked, n.id]));
      drag.current = {
        id: n.id,
        kind: "group",
        wasPicked,
        x0: e.clientX,
        y0: e.clientY,
        step0: b.at,
        len0: b.len,
        row0: rowIds.indexOf(n.padId),
        moved: false,
      };
      return;
    }
    drag.current = {
      id: n.id,
      kind,
      x0: e.clientX,
      y0: e.clientY,
      step0: b.at,
      len0: b.len,
      row0: rowIds.indexOf(n.padId),
      moved: false,
    };
    if (kind === "move")
      startHold(e, () => {
        if (!drag.current || drag.current.moved) return;
        drag.current = null;
        setDraft(null);
        setSel(n.id);
        setMenu({ x: e.clientX, y: e.clientY, padId: n.padId, step: b.at, noteId: n.id });
      });
  };
  const onBlockMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0,
      dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    cancelHold();
    const n = pat.notes.find((x) => x.id === d.id)!;
    if (d.kind === "group") {
      const group = pat.notes.filter((x) => picked.has(x.id) || x.id === d.id);
      const minAt = Math.min(...group.map((x) => blocks.get(x.id)?.at ?? 0));
      const rows = group.map((x) => rowIds.indexOf(x.padId));
      const dStep = Math.max(-minAt, snapTo(dx / pps));
      const dRow = Math.min(
        rowIds.length - 1 - Math.max(...rows),
        Math.max(-Math.min(...rows), Math.round(dy / rowH)),
      );
      setGroupDraft({ dStep, dRow });
      return;
    }
    if (d.kind === "move") {
      const step = Math.min(W - MIN_LEN, Math.max(0, snapTo(d.step0 + dx / pps)));
      const row = Math.min(rowIds.length - 1, Math.max(0, d.row0 + Math.round(dy / rowH)));
      setDraft({ id: d.id, step, length: n.length, padId: rowIds[row] ?? n.padId });
    } else {
      const pad = padOf(n.padId);
      const cap =
        pad?.mode === "oneshot" ? Math.min(blocks.get(d.id)!.natural, W - d.step0) : W - d.step0;
      const len = Math.min(cap, Math.max(MIN_LEN, snapTo(d.len0 + dx / pps)));
      // Stretching a one-shot back to its full length clears the cut.
      setDraft({
        id: d.id,
        step: d.step0,
        length:
          pad?.mode === "oneshot" && len >= cap - 1e-6 && cap >= blocks.get(d.id)!.natural - 1e-6
            ? undefined
            : len,
        padId: n.padId,
      });
    }
  };
  const onBlockUp = () => {
    cancelHold();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "group") {
      if (!d.moved) {
        // a plain tap toggles the hit in or out of the selection
        if (d.wasPicked) setPicked(new Set([...picked].filter((x) => x !== d.id)));
        return;
      }
      const g = groupDraft;
      setGroupDraft(null);
      if (!g || (!g.dStep && !g.dRow)) return;
      const ids = new Set([...picked, d.id]);
      upd((x) => ({
        ...x,
        notes: x.notes.map((nn) => {
          if (!ids.has(nn.id)) return nn;
          const row = rowIds.indexOf(nn.padId);
          return {
            ...nn,
            step: Math.min(W - MIN_LEN, (blocks.get(nn.id)?.at ?? nn.step) + g.dStep),
            offset: 0,
            exact: true,
            padId: rowIds[row + g.dRow] ?? nn.padId,
          };
        }),
      }));
      return;
    }
    if (!d.moved) {
      const n = pat.notes.find((x) => x.id === d.id);
      setSel(sel === d.id ? null : d.id);
      if (n && sel !== d.id) hear(n.padId, n.pitch);
      return;
    }
    if (draft) {
      setNote(draft.id, {
        step: draft.step,
        offset: 0,
        exact: true,
        padId: draft.padId,
        length: draft.length,
      });
      setSel(draft.id);
    }
    setDraft(null);
  };

  const place = (e: React.MouseEvent, padId: string) => {
    if (selectMode) return; // taps on empty grid select (box), they don't add hits
    if (hold.current?.fired) {
      hold.current = null; // the press opened a menu; this tap isn't a new hit
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const step = toFine(Math.floor((e.clientX - r.left) / pps / snap) * snap);
    if (step < 0 || step >= W) return;
    const pad = padOf(padId);
    if (!sliceOf(pad)) return notify(`Pad ${padId} has no sound yet.`);
    const id = uid();
    upd((x) => ({
      ...x,
      notes: [...x.notes, { id, padId, step, velocity: pad!.velocity, offset: 0, exact: true }],
    }));
    setSel(id);
    hear(padId);
  };

  const note = pat.notes.find((n) => n.id === sel);
  const noteBlock = note && blocks.get(note.id);
  const clock = (step: number) => {
    const t = step * sd;
    return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  };
  /** Fraction of a beat as a readable fraction: ¼ ½ ¾, thirds / sixths for triplets, else 2 decimals. */
  const fracBeat = (steps: number) => {
    const sixths = Math.round(steps * 1.5); // 6 sixths of a beat = 4 steps
    if (Math.abs(steps * 1.5 - sixths) < 1e-6) {
      const names: Record<number, string> = { 1: "⅙", 2: "⅓", 3: "½", 4: "⅔", 5: "⅚" };
      if (names[sixths]) return names[sixths];
    }
    const quarters = Math.round(steps * 2); // 8 eighths of a beat = 4 steps
    if (Math.abs(steps * 2 - quarters) < 1e-6) {
      const names: Record<number, string> = { 1: "⅛", 2: "¼", 3: "⅜", 4: "½", 5: "⅝", 6: "¾", 7: "⅞" };
      if (names[quarters]) return names[quarters];
    }
    return (steps / 4).toFixed(2).replace(/^0/, "");
  };
  const fmtPos = (s: number) => {
    const inBeat = s % 4;
    return `bar ${Math.floor(s / 16) + 1} · beat ${Math.floor((s % 16) / 4) + 1}${inBeat > 1e-6 ? ` +${fracBeat(inBeat)}` : ""} · ${clock(s)}`;
  };
  const songBlocks = project.arrangement.length;

  const gridBg = {
    backgroundImage: [
      `linear-gradient(to right, var(--border) 1.5px, transparent 1.5px)`,
      `linear-gradient(to right, color-mix(in oklab, var(--border) 60%, transparent) 1px, transparent 1px)`,
      ...(snap * pps >= 6
        ? [
            `linear-gradient(to right, color-mix(in oklab, var(--border) 30%, transparent) 1px, transparent 1px)`,
          ]
        : []),
    ].join(","),
    backgroundSize: [
      `${16 * pps}px 100%`,
      `${4 * pps}px 100%`,
      ...(snap * pps >= 6 ? [`${snap * pps}px 100%`] : []),
    ].join(","),
  };

  const lengthSelect = (
    <select
      aria-label="Length in bars"
      className="field min-h-9 w-auto shrink-0 text-xs"
      value={L / 16}
      onChange={(e) => {
        const steps = Number(e.target.value) * 16;
        if (
          pat.notes.some((n) => n.step >= steps) &&
          !confirm("Hits past the new end will be removed. Continue?")
        )
          return;
        upd((x) => ({ ...x, lengthSteps: steps, notes: x.notes.filter((n) => n.step < steps) }));
      }}
    >
      {[...new Set([...PATTERN_BARS, L / 16])]
        .sort((a, b) => a - b)
        .map((b) => (
          <option key={b} value={b}>
            {b} bar{b > 1 ? "s" : ""}
          </option>
        ))}
    </select>
  );
  const zoomButtons = (
    <div className="flex shrink-0 items-center gap-1">
      {focusRow && (
        <button
          className="btn btn-on min-h-9 shrink-0 px-2 text-xs"
          onClick={() => setFocusRow(null)}
        >
          {focusRow} · all tracks
        </button>
      )}
      <button
        aria-label="Zoom out"
        className="btn min-h-9 w-9 px-0"
        disabled={pps <= MIN_PPS}
        onClick={() => zoomTo(pps / 1.5)}
      >
        <Minus className="size-4" />
      </button>
      <button
        aria-label="Zoom in"
        className="btn min-h-9 w-9 px-0"
        disabled={pps >= MAX_PPS}
        onClick={() => zoomTo(pps * 1.5)}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
  const addRow = addable.length > 0 && (
    <select
      className={cn(
        "field min-h-9 text-xs text-muted-foreground",
        !full && "min-h-10 w-full text-sm",
      )}
      value=""
      onChange={(e) => e.target.value && setLane(e.target.value, {})}
    >
      <option value="">+ Pad row…</option>
      {addable.map((p) => (
        <option key={p.id} value={p.id}>
          {p.id} · {project.slices.find((s) => s.id === p.sliceId)?.name}
        </option>
      ))}
    </select>
  );

  /** Pointer position in grid content pixels (0,0 = first step of the first row). */
  const contentAt = (e: React.PointerEvent) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return {
      x: e.clientX - r.left + el.scrollLeft - LABEL_W,
      y: e.clientY - r.top + el.scrollTop - RULER_H,
    };
  };
  const finishBand = () => {
    const b = band;
    setBand(null);
    if (!b) return;
    if (Math.abs(b.x1 - b.x0) < 6 && Math.abs(b.y1 - b.y0) < 6) return setPicked(new Set()); // tap on empty grid clears
    const s0 = Math.min(b.x0, b.x1) / pps,
      s1 = Math.max(b.x0, b.x1) / pps;
    const r0 = Math.floor(Math.min(b.y0, b.y1) / rowH),
      r1 = Math.floor(Math.max(b.y0, b.y1) / rowH);
    const hit = pat.notes.filter((n) => {
      const bl = blocks.get(n.id);
      const row = rowIds.indexOf(n.padId);
      return bl && row >= r0 && row <= r1 && bl.at < s1 && bl.at + Math.max(bl.len, MIN_LEN) > s0;
    });
    setPicked(new Set([...picked, ...hit.map((n) => n.id)]));
  };
  const shown = (n: NoteEvent) => {
    if (draft?.id === n.id) return { padId: draft.padId, at: draft.step };
    const at = blocks.get(n.id)?.at ?? n.step;
    if (groupDraft && (picked.has(n.id) || drag.current?.id === n.id))
      return {
        padId: rowIds[rowIds.indexOf(n.padId) + groupDraft.dRow] ?? n.padId,
        at: Math.max(0, at + groupDraft.dStep),
      };
    return { padId: n.padId, at };
  };

  const grid = (
    <div
      ref={scroller}
      className={cn(
        "relative overflow-auto overscroll-contain rounded-md border bg-background",
        full ? "min-h-0 flex-1" : "max-h-[60vh]",
      )}
      style={{
        touchAction: selectMode ? "none" : "pan-x pan-y",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
      }}
      onScroll={readView}
    >
      <div className="relative" style={{ width: LABEL_W + W * pps }}>
        {/* ruler */}
        <div className="sticky top-0 z-30 flex border-b bg-background" style={{ height: RULER_H }}>
          <div
            className="sticky left-0 z-20 shrink-0 border-r bg-background"
            style={{ width: LABEL_W }}
          />
          <div className="relative" style={{ width: W * pps }}>
            {Array.from({ length: W / 16 }, (_, b) =>
              b !== L / 16 && (16 * pps >= 28 || b % Math.ceil(28 / (16 * pps)) === 0) ? (
                <span
                  key={b}
                  className="absolute top-1 whitespace-nowrap font-mono text-[10px] text-muted-foreground"
                  style={{ left: b * 16 * pps + 3 }}
                >
                  {b + 1}
                  {16 * pps >= 72 && <span className="opacity-60"> · {clock(b * 16)}</span>}
                </span>
              ) : null,
            )}
            <span
              className="absolute top-0 bottom-0 z-10 whitespace-nowrap border-l-2 border-primary bg-background pl-1 pr-1 font-mono text-[10px] leading-6 text-primary"
              style={{ left: L * pps }}
            >
              End · {clock(L)}
            </span>
          </div>
        </div>

        {rowIds.map((padId) => {
          const pad = padOf(padId);
          const slice = sliceOf(pad);
          const lane = laneOf(padId);
          const img = slice && pad ? waveImage(slice, pad.reverse) : null;
          const notes = pat.notes.filter((n) => shown(n).padId === padId);
          return (
            <div
              key={padId}
              className={cn("flex border-b", lane.mute && "opacity-50")}
              style={{ height: rowH }}
            >
              <div
                className="sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 border-r bg-surface px-1.5"
                style={{ width: LABEL_W }}
              >
                <button
                  aria-label={`Track ${padId} options`}
                  className="truncate text-left text-[11px] font-semibold leading-tight underline decoration-dotted underline-offset-2"
                  onClick={(e) =>
                    setMenu({ x: e.clientX, y: e.clientY, padId, step: 0, row: true })
                  }
                >
                  <span className="font-mono text-muted-foreground">{padId}</span>{" "}
                  {slice?.name ?? "Empty"}
                </button>
                <div className="flex gap-1">
                  <button
                    aria-pressed={lane.mute}
                    className={cn("btn min-h-5 flex-1 px-0 text-[10px]", lane.mute && "bg-rec")}
                    onClick={() => setLane(padId, { mute: !lane.mute })}
                  >
                    M
                  </button>
                  <button
                    aria-pressed={lane.solo}
                    className={cn("btn min-h-5 flex-1 px-0 text-[10px]", lane.solo && "btn-on")}
                    onClick={() => setLane(padId, { solo: !lane.solo })}
                  >
                    S
                  </button>
                </div>
              </div>
              <div
                aria-label={`Timeline row ${padId}`}
                className="relative"
                style={{ width: W * pps, ...gridBg }}
                onClick={(e) => place(e, padId)}
                onPointerDown={(e) => {
                  if (selectMode) {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const c = contentAt(e);
                    setBand({ x0: c.x, y0: c.y, x1: c.x, y1: c.y });
                    return;
                  }
                  const r = e.currentTarget.getBoundingClientRect();
                  const step = Math.min(
                    W - MIN_LEN,
                    Math.max(0, toFine(Math.floor((e.clientX - r.left) / pps / snap) * snap)),
                  );
                  startHold(e, () => setMenu({ x: e.clientX, y: e.clientY, padId, step }));
                }}
                onPointerMove={(e) => {
                  if (band) {
                    const c = contentAt(e);
                    setBand({ ...band, x1: c.x, y1: c.y });
                  } else movedHold(e);
                }}
                onPointerUp={() => {
                  if (band) finishBand();
                  else if (!hold.current?.fired) cancelHold();
                }}
                onPointerCancel={cancelHold}
                onContextMenu={(e) => e.preventDefault()}
              >
                {notes.map((n) => {
                  const b = blocks.get(n.id);
                  if (!b) return null;
                  const at = shown(n).at;
                  const len =
                    draft?.id === n.id
                      ? Math.min(
                          draft.length ?? (pad?.mode === "oneshot" ? b.natural : b.len),
                          W - at,
                        )
                      : b.len;
                  const on = selectMode ? picked.has(n.id) : sel === n.id;
                  return (
                    <div
                      key={n.id}
                      role="button"
                      aria-label={`Hit ${padId} at ${fmtPos(at)}`}
                      className={cn(
                        "absolute top-1 bottom-1 touch-none overflow-hidden rounded-sm border",
                        pad ? BLOCK[pad.color] : "border-border bg-surface-2",
                        on && "ring-2 ring-foreground",
                      )}
                      style={{
                        left: at * pps,
                        width: Math.max(3, len * pps),
                        opacity: 0.45 + 0.55 * (n.velocity / 127),
                        backgroundImage: img ? `url(${img})` : undefined,
                        backgroundSize: `${Math.max(1, b.natural * pps)}px 100%`,
                        backgroundRepeat: pad?.mode === "loop" ? "repeat-x" : "no-repeat",
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => onBlockDown(e, n, "move")}
                      onPointerMove={onBlockMove}
                      onPointerUp={onBlockUp}
                      onPointerCancel={() => {
                        cancelHold();
                        drag.current = null;
                        setDraft(null);
                      }}
                      onContextMenu={(e) => e.preventDefault()}
                    />
                  );
                })}
                {/* Resize handle sits just after the selected hit so even a 1/32 hit can be grabbed. */}
                {!selectMode &&
                  note &&
                  noteBlock &&
                  (draft?.id === note.id ? draft.padId : note.padId) === padId && (
                    <div
                      role="button"
                      aria-label="Drag to change the hit's length"
                      className="absolute top-1 bottom-1 z-10 w-4 touch-none rounded-r-sm bg-foreground/80"
                      style={{
                        left:
                          ((draft?.id === note.id ? draft.step : noteBlock.at) +
                            (draft?.id === note.id
                              ? Math.min(draft.length ?? noteBlock.natural, W)
                              : noteBlock.len)) *
                          pps,
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => onBlockDown(e, note, "size")}
                      onPointerMove={onBlockMove}
                      onPointerUp={onBlockUp}
                    />
                  )}
              </div>
            </div>
          );
        })}

        {band && (
          <div
            className="pointer-events-none absolute z-20 rounded-sm border-2 border-primary bg-primary/15"
            style={{
              left: LABEL_W + Math.min(band.x0, band.x1),
              top: RULER_H + Math.min(band.y0, band.y1),
              width: Math.abs(band.x1 - band.x0),
              height: Math.abs(band.y1 - band.y0),
            }}
          />
        )}
        {/* Past the song's end: still open for hits — placing one there makes the song longer. */}
        <div
          className="pointer-events-none absolute top-6 bottom-0 z-[5] border-l-2 border-primary bg-background/40"
          style={{ left: LABEL_W + L * pps, width: (W - L) * pps }}
        />
        {head >= 0 && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-foreground"
            style={{ left: LABEL_W + head * pps }}
          />
        )}
      </div>
    </div>
  );

  // Overview of the whole beat: hits as ticks, the visible window as a box. Drag or tap to fly there.
  const gridPx = Math.max(1, view.total - LABEL_W);
  const winL = Math.min(1, view.left / gridPx);
  const winW = Math.min(1 - winL, Math.max(0.02, (view.width - LABEL_W) / gridPx));
  const flyTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    el.scrollLeft = f * gridPx - (el.clientWidth - LABEL_W) / 2;
  };
  const overview = (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        aria-label="Jump to the start"
        className="btn min-h-8 w-9 shrink-0 px-0"
        onClick={() => scroller.current?.scrollTo({ left: 0 })}
      >
        <SkipBack className="size-4" />
      </button>
      <div
        aria-label="Song overview — drag to move through the beat"
        className="relative h-8 min-w-0 flex-1 touch-none overflow-hidden rounded-sm border bg-surface"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          flyTo(e);
        }}
        onPointerMove={(e) => e.buttons && flyTo(e)}
      >
        <span
          className="absolute top-0 bottom-0 left-0 bg-primary/10"
          style={{ width: `${(L / W) * 100}%` }}
        />
        {pat.notes.map((n) => {
          const b = blocks.get(n.id);
          const row = rowIds.indexOf(n.padId);
          if (!b || row < 0) return null;
          return (
            <span
              key={n.id}
              className="absolute w-px bg-primary/70"
              style={{
                left: `${(b.at / W) * 100}%`,
                top: `${(row / Math.max(1, rowIds.length)) * 100}%`,
                height: `${100 / Math.max(1, rowIds.length)}%`,
              }}
            />
          );
        })}
        {head >= 0 && (
          <span
            className="absolute top-0 bottom-0 w-0.5 bg-foreground"
            style={{ left: `${(head / W) * 100}%` }}
          />
        )}
        <span
          className="pointer-events-none absolute top-0 bottom-0 rounded-sm border-2 border-foreground/80 bg-foreground/10"
          style={{ left: `${winL * 100}%`, width: `${winW * 100}%` }}
        />
      </div>
      <button
        aria-label="Jump to the end of the song"
        className="btn min-h-8 w-9 shrink-0 px-0"
        onClick={() => {
          const el = scroller.current;
          if (el) el.scrollTo({ left: Math.max(0, L * pps - (el.clientWidth - LABEL_W) + 48) });
        }}
      >
        <SkipForward className="size-4" />
      </button>
      <button
        aria-label="Fit the whole beat on screen"
        className="btn min-h-8 shrink-0 px-2 text-xs"
        onClick={fit}
      >
        Fit
      </button>
    </div>
  );

  const menuNote = menu?.noteId ? pat.notes.find((n) => n.id === menu.noteId) : undefined;
  const closeMenu = () => {
    setMenu(null);
    hold.current = null;
  };
  /** Paste at `step`: one hit lands on the row you pressed; a group keeps its own rows and spacing. */
  const paste = (padId: string, step: number) => {
    if (!clip?.length) return;
    const made = clip.map(({ rel, ...c }) => ({
      ...c,
      id: uid(),
      padId: clip.length === 1 ? padId : c.padId,
      step: Math.min(W - MIN_LEN, step + rel),
      offset: 0,
      exact: true,
    }));
    upd((x) => ({ ...x, notes: [...x.notes, ...made] }));
    if (made.length === 1) {
      setSel(made[0].id);
      hear(padId);
    } else {
      setSelectMode(true);
      setPicked(new Set(made.map((m) => m.id)));
    }
  };
  const menuItem = (label: string, Icon: typeof Copy, run: () => void, disabled = false) => (
    <button
      key={label}
      disabled={disabled}
      className="flex min-h-11 w-full items-center gap-2 rounded-sm px-3 text-left text-sm hover:bg-surface-2 disabled:opacity-40"
      onClick={() => {
        run();
        closeMenu();
      }}
    >
      <Icon className="size-4" /> {label}
    </button>
  );
  const menuEl = menu && (
    <>
      <div
        className="fixed inset-0 z-[60]"
        onClick={closeMenu}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        role="menu"
        aria-label={menu.row ? "Track menu" : menuNote ? "Hit menu" : "Grid menu"}
        className="fixed z-[61] w-56 rounded-md border bg-popover p-1 shadow-lg"
        style={{
          left: Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 400) - 232),
          top: Math.min(
            menu.y + 8,
            (typeof window !== "undefined" ? window.innerHeight : 800) -
              (menuNote ? 244 : menu.row ? 150 : 60),
          ),
        }}
      >
        {menu.row ? (
          <>
            {focusRow
              ? menuItem("Show all tracks", Maximize, () => setFocusRow(null))
              : menuItem("Focus this track", Maximize, () => {
                  setFocusRow(menu.padId);
                  setSelectMode(false);
                })}
            {menuItem(`Quantize this track (${snapName})`, Magnet, () =>
              quantize(pat.notes.filter((n) => n.padId === menu.padId).map((n) => n.id)),
            )}
            {menuItem("Select this track's hits", BoxSelect, () => {
              setSelectMode(true);
              setSel(null);
              setPicked(new Set(pat.notes.filter((n) => n.padId === menu.padId).map((n) => n.id)));
            })}
          </>
        ) : menuNote ? (
          <>
            {menuItem("Copy", Copy, () => copyHit(menuNote))}
            {menuItem("Cut", Scissors, () => {
              copyHit(menuNote);
              upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id !== menuNote.id) }));
              setSel(null);
            })}
            {menuItem("Duplicate after", CopyPlus, () => {
              const b = blocks.get(menuNote.id);
              const at = b ? b.at + Math.max(MIN_LEN, b.len) : L;
              if (at >= W) return notify(`That's past the ${MAX_PATTERN_BARS}-bar limit.`);
              const id = uid();
              upd((x) => ({
                ...x,
                notes: [...x.notes, { ...menuNote, id, step: at, offset: 0, exact: true }],
              }));
              setSel(id);
            })}
            {menuItem("Delete", Trash2, () => {
              upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id !== menuNote.id) }));
              setSel(null);
            })}
            {menuItem("Select several…", BoxSelect, () => {
              setSelectMode(true);
              setPicked(new Set([menuNote.id]));
            })}
          </>
        ) : clip ? (
          menuItem(
            clip.length === 1 ? `Paste here (${menu.padId})` : `Paste ${clip.length} hits here`,
            ClipboardPaste,
            () => paste(menu.padId, menu.step),
          )
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Hold a hit and choose Copy first.
          </p>
        )}
      </div>
    </>
  );

  const pickedNotes = pat.notes.filter((n) => picked.has(n.id));
  /** The selection's length, rounded up to whole beats (or bars, once it's most of a bar). */
  const groupSpan = (() => {
    if (!pickedNotes.length) return 0;
    const at = (n: NoteEvent) => blocks.get(n.id)?.at ?? n.step;
    const s0 = Math.min(...pickedNotes.map(at));
    const e = Math.max(
      ...pickedNotes.map(
        (n) => at(n) + Math.max(MIN_LEN, n.length ?? Math.min(blocks.get(n.id)?.len ?? 1, 64)),
      ),
    );
    const span = e - s0;
    const unit = span >= 12 ? 16 : 4;
    return Math.ceil(span / unit - 1e-9) * unit;
  })();
  const repeatGroup = (times: number) => {
    if (!pickedNotes.length) return;
    const made: NoteEvent[] = [];
    for (let k = 1; k <= times; k++)
      for (const n of pickedNotes) {
        const step = (blocks.get(n.id)?.at ?? n.step) + groupSpan * k;
        if (step < W) made.push({ ...n, id: uid(), step, offset: 0, exact: true });
      }
    if (!made.length) return notify(`That's past the ${MAX_PATTERN_BARS}-bar limit.`);
    upd((x) => ({ ...x, notes: [...x.notes, ...made] }));
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, (Math.max(...made.map((m) => m.step)) - 8) * pps);
  };
  const exitSelect = () => {
    setSelectMode(false);
    setPicked(new Set());
  };
  const groupBar = (
    <section
      className={cn(
        "timeline-hit-panel panel flex flex-wrap items-center gap-2",
        full && "flex-nowrap overflow-x-auto p-1.5",
      )}
    >
      <div className="eyebrow shrink-0">
        {picked.size
          ? `${picked.size} selected · ${groupSpan % 16 ? `${groupSpan / 4} beats` : `${groupSpan / 16} bar${groupSpan === 16 ? "" : "s"}`}`
          : "Tap hits or drag a box"}
      </div>
      <button
        className="btn min-h-9 shrink-0 text-xs"
        onClick={() => setPicked(new Set(pat.notes.map((n) => n.id)))}
      >
        All
      </button>
      <button
        className="btn min-h-9 shrink-0 text-xs"
        disabled={!picked.size}
        onClick={() => {
          copyHits(pickedNotes, (x) => blocks.get(x.id)?.at ?? x.step);
          notify(
            `Copied ${pickedNotes.length} hit${pickedNotes.length === 1 ? "" : "s"} — hold empty grid to paste.`,
          );
        }}
      >
        <Copy className="size-4" /> Copy
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-xs text-muted-foreground">Repeat</span>
        {[1, 2, 4, 8].map((t) => (
          <button
            key={t}
            aria-label={`Repeat ${t} times`}
            className="btn min-h-9 px-2.5 text-xs"
            disabled={!picked.size}
            onClick={() => repeatGroup(t)}
          >
            ×{t}
          </button>
        ))}
      </div>
      <button
        aria-label="Quantize selected"
        className="btn min-h-9 shrink-0 text-xs"
        disabled={!picked.size}
        onClick={() => quantize(picked)}
      >
        <Magnet className="size-4" /> Quantize
      </button>
      <button
        aria-label="Delete selected"
        className="btn min-h-9 shrink-0 text-xs"
        disabled={!picked.size}
        onClick={() => {
          upd((x) => ({ ...x, notes: x.notes.filter((n) => !picked.has(n.id)) }));
          setPicked(new Set());
        }}
      >
        <Trash2 className="size-4" />
      </button>
      <button className="btn btn-on min-h-9 shrink-0 text-xs" onClick={exitSelect}>
        Done
      </button>
    </section>
  );

  const hitPanel = selectMode ? (
    groupBar
  ) : note && noteBlock ? (
    <section
      className={cn(
        "timeline-hit-panel panel",
        full ? "flex items-center gap-2 overflow-x-auto p-1.5" : "space-y-2",
      )}
    >
      <div className={cn("flex items-center gap-2", full && "shrink-0")}>
        <div className={cn("eyebrow truncate", !full && "min-w-0 flex-1")}>
          {note.padId} · {fmtPos(noteBlock.at)}
        </div>
        <button
          aria-label="Duplicate hit"
          className="btn min-h-9 shrink-0 text-xs"
          onClick={() => {
            const at = noteBlock.at + Math.max(MIN_LEN, noteBlock.len);
            if (at >= W) return notify(`That's past the ${MAX_PATTERN_BARS}-bar limit.`);
            const id = uid();
            upd((x) => ({
              ...x,
              notes: [...x.notes, { ...note, id, step: at, offset: 0, exact: true }],
            }));
            setSel(id);
          }}
        >
          <Copy className="size-4" /> {full ? "" : "Copy after"}
        </button>
        <button
          aria-label="Quantize hit"
          title={`Snap to the ${snapName} grid`}
          className="btn min-h-9 shrink-0 text-xs"
          onClick={() => quantize([note.id])}
        >
          <Magnet className="size-4" /> {full ? "" : "Quantize"}
        </button>
        <button
          aria-label="Roll"
          aria-pressed={rollOpen}
          title="Turn this hit into a roll"
          className={cn("btn min-h-9 shrink-0 text-xs", rollOpen && "btn-on")}
          onClick={() => setRollOpen(!rollOpen)}
        >
          <Repeat className="size-4" /> {full ? "" : "Roll"}
        </button>
        <button
          aria-label="Delete hit"
          className="btn min-h-9 shrink-0 text-xs"
          onClick={() => {
            upd((x) => ({ ...x, notes: x.notes.filter((n) => n.id !== note.id) }));
            setSel(null);
          }}
        >
          <Trash2 className="size-4" /> {full ? "" : "Delete"}
        </button>
      </div>
      {rollOpen && (
        <div
          className={cn("space-y-2 rounded-md bg-surface p-2", full && "w-[26rem] shrink-0")}
          aria-label="Roll settings"
        >
          <div className="grid grid-cols-[3.5rem_1fr] items-center gap-2 text-xs">
            <span className="text-muted-foreground">Rate</span>
            <Segmented
              value={roll.rate}
              onChange={(v) => setRoll({ ...roll, rate: v })}
              options={ROLL_RATES}
            />
            <span className="text-muted-foreground">Length</span>
            <Segmented
              value={roll.length}
              onChange={(v) => setRoll({ ...roll, length: v })}
              options={ROLL_LENGTHS}
            />
            <span className="text-muted-foreground">Volume</span>
            <Segmented
              value={roll.vel}
              onChange={(v) => setRoll({ ...roll, vel: v })}
              options={[
                { value: "none", label: "Even" },
                { value: "up", label: "Ramp up" },
                { value: "down", label: "Ramp down" },
              ]}
            />
            <span className="text-muted-foreground">Pitch</span>
            <div className="flex items-center gap-1">
              <button
                aria-label="Pitch ramp down"
                className="btn min-h-9 w-9 px-0"
                onClick={() => setRoll({ ...roll, pitch: Math.max(-12, roll.pitch - 1) })}
              >
                −
              </button>
              <span className="w-16 text-center font-mono">
                {roll.pitch === 0 ? "none" : `${roll.pitch > 0 ? "+" : ""}${roll.pitch} st`}
              </span>
              <button
                aria-label="Pitch ramp up"
                className="btn min-h-9 w-9 px-0"
                onClick={() => setRoll({ ...roll, pitch: Math.min(12, roll.pitch + 1) })}
              >
                +
              </button>
              <span className="text-[10px] text-muted-foreground">across the roll</span>
            </div>
          </div>
          <button
            className="btn btn-primary min-h-9 w-full text-xs"
            onClick={() => {
              if (noteBlock.at + roll.length > W)
                return notify(`That roll runs past the ${MAX_PATTERN_BARS}-bar limit.`);
              upd((x) => ({
                ...x,
                lengthSteps: Math.max(x.lengthSteps, stepsToFit(noteBlock.at + roll.length)),
                notes: applyRoll(x.notes, note.id, {
                  rate: roll.rate,
                  lengthSteps: roll.length,
                  velocityRamp: roll.vel,
                  pitchRamp: roll.pitch,
                  makeId: uid,
                }),
              }));
              setRollOpen(false);
              notify(
                `Rolled into ${rollCount(roll.rate, roll.length)} hits — undo brings the single hit back.`,
              );
            }}
          >
            <Repeat className="size-4" /> Apply roll · {rollCount(roll.rate, roll.length)} hits
          </button>
        </div>
      )}
      <div className={cn(full && "w-[22rem] shrink-0")}>
        {!full && <div className="eyebrow mb-1">Length</div>}
        <Segmented
          value={note.length ?? 0}
          onChange={(v) => setNote(note.id, { length: v === 0 ? undefined : v })}
          options={LENGTHS}
        />
      </div>
      {(() => {
        const pad = padOf(note.padId);
        const src = project.slices.find((x) => x.id === pad?.sliceId)?.sourceId;
        const k = src ? parseKitSourceId(src) : null;
        const inst =
          k?.kitId === INSTRUMENTS.id
            ? INSTRUMENTS.drums.find((d) => d.id === k.drumId)
            : undefined;
        const pitch = note.pitch ?? 0;
        const setPitch = (v: number) => {
          const next = Math.max(-48, Math.min(48, v));
          setNote(note.id, { pitch: next || undefined } as Partial<NoteEvent>);
          hear(note.padId, next);
        };
        return (
          <>
            <div className={cn("flex items-center gap-1 text-xs", full && "shrink-0")}>
              <span className="mr-1 text-muted-foreground">Pitch</span>
              <button
                aria-label="Pitch down"
                className="btn min-h-9 w-9 px-0"
                onClick={() => setPitch(pitch - 1)}
              >
                −
              </button>
              <span className="w-12 text-center font-mono">
                {inst
                  ? noteName((inst.rootMidi ?? 36) + (pad?.pitch ?? 0) + pitch)
                  : `${pitch > 0 ? "+" : ""}${pitch} st`}
              </span>
              <button
                aria-label="Pitch up"
                className="btn min-h-9 w-9 px-0"
                onClick={() => setPitch(pitch + 1)}
              >
                +
              </button>
            </div>
            {inst && pad && (
              <div
                className={cn("flex gap-1 overflow-x-auto", full && "shrink-0")}
                aria-label="Instrument"
              >
                {INSTRUMENTS.drums.map((d) => (
                  <button
                    key={d.id}
                    className={cn(
                      "btn min-h-9 shrink-0 px-2 text-xs",
                      d.id === inst.id && "btn-on",
                    )}
                    onClick={() => {
                      const loaded = kitService.loadDrum(INSTRUMENTS.id, d.id);
                      if (!loaded) return;
                      // same pad, new sound: every hit (and its pitch) stays where it is
                      commit((p) => pruneKitSources(assignDrum(p, pad.id, loaded, uid())));
                      setTimeout(() => hear(pad.id, pitch), 30);
                    }}
                  >
                    {d.short}
                  </button>
                ))}
              </div>
            )}
          </>
        );
      })()}
      <label className={cn("flex items-center gap-3 text-xs", full && "w-48 shrink-0 gap-2")}>
        <span className="shrink-0 text-muted-foreground">{full ? "Vel" : "Velocity"}</span>
        <input
          type="range"
          min={1}
          max={127}
          value={note.velocity}
          className="h-8 min-w-0 flex-1"
          onChange={(e) =>
            upd(
              (x) => ({
                ...x,
                notes: x.notes.map((n) =>
                  n.id === note.id ? { ...n, velocity: Number(e.target.value) } : n,
                ),
              }),
              false,
            )
          }
        />
        <span className="w-8 text-right font-mono">{note.velocity}</span>
      </label>
    </section>
  ) : (
    <p className="px-1 text-[11px] text-muted-foreground">
      Tap a track's name to focus it (fills the screen) or quantize it · Mic: hum a bassline or
      melody (or beatbox drums) and pick the instrument · Select (box icon) to pick several hits,
      drag them together, copy them or repeat them · hold a hit to copy, cut or delete it · hold
      empty grid to paste · pinch to zoom · drag empty grid to scroll · drag the strip below the
      grid to jump around · tap the grid to place a hit · drag a hit to move it (up or down to
      change pads) · tap it, then drag the white handle to shorten it, down to 1/32. Loop pads
      repeat to fill a longer hit.
    </p>
  );

  const songButton = songBlocks > 0 && (
    <button
      className="btn min-h-9 shrink-0 text-xs"
      onClick={() => {
        try {
          const r = songToTimeline(project);
          commit(() => r.project);
          setLoopMode("pattern");
          notify("Your Song is now one long pattern here. The original patterns are kept.");
        } catch (err) {
          notify((err as Error).message);
        }
      }}
    >
      Song → Timeline
    </button>
  );

  if (full)
    return (
      <div
        className="timeline-studio timeline-full fixed inset-0 z-40 flex flex-col gap-1.5 bg-background p-1.5"
        style={{
          paddingLeft: "max(0.375rem, env(safe-area-inset-left))",
          paddingRight: "max(0.375rem, env(safe-area-inset-right))",
        }}
        data-audio={audioVersion}
      >
        <div className="timeline-toolbar flex shrink-0 items-center gap-1.5 overflow-x-auto">
          <button
            aria-label="Exit full screen"
            className="btn min-h-9 w-9 shrink-0 px-0"
            onClick={() => {
              setFullDismissed(true);
              setForceFull(false);
            }}
          >
            <Minimize2 className="size-4" />
          </button>
          <button
            aria-label={playing ? "Stop" : "Play"}
            onClick={() => void togglePlay()}
            className={cn("btn min-h-9 w-12 shrink-0 px-0", playing ? "btn-on" : "btn-primary")}
          >
            {playing ? (
              <Square className="size-4 fill-current" />
            ) : (
              <Play className="size-4 fill-current" />
            )}
          </button>
          <button
            aria-label="Repeat"
            aria-pressed={repeat}
            title={repeat ? "Repeat on: the beat loops" : "Repeat off: plays once, then stops"}
            onClick={() => setRepeat(!repeat)}
            className={cn("btn min-h-9 w-9 shrink-0 px-0", repeat && "btn-on")}
          >
            <Repeat className="size-4" />
          </button>
          <button
            aria-label="Record a sound — hum or beatbox"
            title="Hum a line or beatbox drums"
            className="btn min-h-9 w-9 shrink-0 px-0"
            onClick={() => setHumOpen(true)}
          >
            <Mic className="size-4 text-rec" />
          </button>
          <button
            aria-label="Add trap drums"
            title="Generate hats, snares and claps over this pattern"
            className="btn min-h-9 shrink-0 text-xs"
            onClick={() => setTrapOpen(true)}
          >
            <Plus className="size-4" /> Trap drums
          </button>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {project.bpm} BPM
          </span>
          <button
            aria-label="Select several hits"
            aria-pressed={selectMode}
            title="Select several hits"
            className={cn("btn min-h-9 w-9 shrink-0 px-0", selectMode && "btn-on")}
            onClick={() => (selectMode ? exitSelect() : (setSelectMode(true), setSel(null)))}
          >
            <BoxSelect className="size-4" />
          </button>
          <Segmented
            className="w-[23rem] shrink-0"
            value={snap}
            onChange={(v) => setSnap(v)}
            options={SNAPS}
          />
          {zoomButtons}
          {lengthSelect}
          {addRow}
          {songButton}
        </div>
        {grid}
        {overview}
        <div className="shrink-0">{hitPanel}</div>
        {menuEl}
        {humOpen && <HumRecorder pat={pat} snap={snap} onClose={() => setHumOpen(false)} />}
        {trapOpen && <TrapDrums pat={pat} onClose={() => setTrapOpen(false)} />}
      </div>
    );

  return (
    <div className="timeline-studio panel space-y-3" data-audio={audioVersion}>
      <div className="timeline-toolbar flex flex-wrap items-center gap-2">
        <span className="eyebrow w-full">Timeline / snap grid</span>
        <Segmented
          className="basis-full"
          value={snap}
          onChange={(v) => setSnap(v)}
          options={SNAPS}
        />
        <div className="flex-1" />
        <button
          aria-label="Record a sound — hum or beatbox"
          title="Hum a line or beatbox drums"
          className="btn min-h-9 w-9 shrink-0 px-0"
          onClick={() => setHumOpen(true)}
        >
          <Mic className="size-4 text-rec" />
        </button>
        <button
          aria-label="Add trap drums"
          title="Generate hats, snares and claps over this pattern"
          className="btn min-h-9 shrink-0 text-xs"
          onClick={() => setTrapOpen(true)}
        >
          <Plus className="size-4" /> Add trap drums
        </button>
        <button
          aria-label="Select several hits"
          aria-pressed={selectMode}
          title="Select several hits"
          className={cn("btn min-h-9 w-9 shrink-0 px-0", selectMode && "btn-on")}
          onClick={() => (selectMode ? exitSelect() : (setSelectMode(true), setSel(null)))}
        >
          <BoxSelect className="size-4" />
        </button>
        {zoomButtons}
        {lengthSelect}
        {songButton}
        <button
          aria-label="Full screen"
          className="btn min-h-9 w-9 shrink-0 px-0"
          onClick={() => {
            setForceFull(true);
            setFullDismissed(false);
          }}
        >
          <Maximize2 className="size-4" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Turn your phone sideways for a full-screen timeline.
      </p>
      {grid}
      {overview}
      {addRow}
      {hitPanel}
      {menuEl}
      {humOpen && <HumRecorder pat={pat} snap={snap} onClose={() => setHumOpen(false)} />}
      {trapOpen && <TrapDrums pat={pat} onClose={() => setTrapOpen(false)} />}
    </div>
  );
}

/** True while a phone is held sideways (short landscape screen). */
function usePhoneLandscape() {
  const q = "(orientation: landscape) and (max-height: 520px)";
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return on;
}
