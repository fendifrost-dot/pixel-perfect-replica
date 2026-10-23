import { useEffect, useRef } from "react";
import { waveColumns } from "@/lib/frost/analysis";

export type WaveMode = "select" | "chop" | "beats";

interface Props {
  /** Decoded audio; when present, the view is drawn from real samples at any zoom. */
  buffer?: AudioBuffer | undefined;
  /** Fallback overview (demo). */
  peaks: Float32Array;
  duration: number;
  viewStart: number;
  viewEnd: number;
  onView: (start: number, end: number) => void;
  selection: { start: number; end: number } | null;
  markers: number[];
  beats: number[];
  mode: WaveMode;
  onSelect: (start: number, end: number, final: boolean) => void;
  onMarkers: (m: number[], final: boolean) => void;
  onBeatMove: (index: number, t: number, final: boolean) => void;
}

const MIN_SPAN = 0.02;

/**
 * Canvas waveform. One finger: select / add-drag chop markers / drag beat markers (by mode).
 * Two fingers: pinch to zoom, drag to scroll.
 */
export function Waveform(props: Props) {
  const { buffer, peaks, duration, viewStart, viewEnd, selection, markers, beats, mode } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const P = useRef(props);
  P.current = props;
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ d0: number; c0: number; s0: number; e0: number } | null>(null);
  const drag = useRef<
    | { kind: "sel"; mode: "start" | "end" | "new"; anchor: number }
    | { kind: "marker"; index: number; moved: boolean; created: boolean; x0: number }
    | { kind: "beat"; index: number }
    | null
  >(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      c.width = w * dpr;
      c.height = h * dpr;
      const g = c.getContext("2d")!;
      g.scale(dpr, dpr);
      const css = getComputedStyle(c);
      const wave = css.getPropertyValue("--wave").trim();
      const amber = css.getPropertyValue("--primary").trim();
      const teal = css.getPropertyValue("--pad-teal").trim();
      const purple = css.getPropertyValue("--pad-purple").trim() || teal;
      const span = viewEnd - viewStart;
      const tx = (t: number) => ((t - viewStart) / span) * w;
      if (selection) {
        g.fillStyle = amber;
        g.globalAlpha = 0.18;
        g.fillRect(tx(selection.start), 0, tx(selection.end) - tx(selection.start), h);
        g.globalAlpha = 1;
      }
      // beat grid underneath
      g.fillStyle = purple;
      for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        if (t < viewStart || t > viewEnd) continue;
        g.globalAlpha = mode === "beats" ? 0.9 : 0.4;
        g.fillRect(tx(t) - 0.5, 0, i % 4 === 0 ? 2 : 1, h);
        if (mode === "beats") g.fillRect(tx(t) - 6, 0, 12, 12);
      }
      g.globalAlpha = 1;
      g.fillStyle = wave;
      const mid = h / 2;
      const cols = Math.max(1, Math.floor(w));
      const data = buffer ? waveColumns(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate, viewStart, viewEnd, cols) : null;
      for (let x = 0; x < cols; x++) {
        let lo: number, hi: number;
        if (data) {
          lo = data[x * 2];
          hi = data[x * 2 + 1];
        } else {
          const t = viewStart + (x / w) * span;
          const i = Math.floor((t / duration) * peaks.length);
          hi = peaks[Math.min(peaks.length - 1, Math.max(0, i))] ?? 0;
          lo = -hi;
        }
        const t = viewStart + (x / w) * span;
        g.globalAlpha = selection && t >= selection.start && t <= selection.end ? 1 : 0.55;
        g.fillRect(x, mid - hi * mid * 0.92, 1, Math.max(1, (hi - lo) * mid * 0.92));
      }
      g.globalAlpha = 1;
      g.fillStyle = teal;
      for (const m of markers) {
        if (m < viewStart || m > viewEnd) continue;
        g.fillRect(tx(m) - 1, 0, 2, h);
        g.fillRect(tx(m) - 7, h - 14, 14, 14); // handle: tap to delete, drag to move
      }
      if (selection && mode === "select") {
        g.fillStyle = amber;
        for (const t of [selection.start, selection.end]) {
          g.fillRect(tx(t) - 1.5, 0, 3, h);
          g.fillRect(tx(t) - 8, h - 18, 16, 18);
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [buffer, peaks, duration, viewStart, viewEnd, selection, markers, beats, mode]);

  const timeAt = (clientX: number) => {
    const p = P.current;
    const r = canvas.current!.getBoundingClientRect();
    const t = p.viewStart + ((clientX - r.left) / r.width) * (p.viewEnd - p.viewStart);
    return Math.min(p.duration, Math.max(0, t));
  };
  const tol = () => 22 / (canvas.current!.clientWidth / (P.current.viewEnd - P.current.viewStart));
  const nearest = (list: number[], t: number) => {
    let bi = -1, bd = Infinity;
    list.forEach((m, i) => {
      const d = Math.abs(m - t);
      if (d < bd) { bd = d; bi = i; }
    });
    return bd < tol() ? bi : -1;
  };

  const startPinch = () => {
    const xs = [...pointers.current.values()];
    const p = P.current;
    pinch.current = { d0: Math.max(10, Math.abs(xs[0] - xs[1])), c0: timeAt((xs[0] + xs[1]) / 2), s0: p.viewStart, e0: p.viewEnd };
    drag.current = null;
  };

  return (
    <canvas
      ref={canvas}
      className="no-touch-scroll block h-44 w-full rounded-md bg-background sm:h-56"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, e.clientX);
        if (pointers.current.size === 2) return startPinch();
        if (pointers.current.size > 2) return;
        const p = P.current;
        const t = timeAt(e.clientX);
        // A chop marker under the finger can be tapped away (or dragged) in any mode.
        const onMarker = nearest(p.markers, t);
        const grab = (index: number, created = false) => (drag.current = { kind: "marker", index, moved: false, created, x0: e.clientX });
        if (p.mode === "chop") {
          if (onMarker >= 0) grab(onMarker);
          else {
            const next = [...p.markers, t].sort((a, b) => a - b);
            p.onMarkers(next, false);
            grab(next.indexOf(t), true);
          }
        } else if (p.mode === "beats") {
          const i = nearest(p.beats, t);
          if (i >= 0) drag.current = { kind: "beat", index: i };
          else if (onMarker >= 0) grab(onMarker);
          else drag.current = null;
        } else {
          const s = p.selection;
          if (s && Math.abs(t - s.start) < tol()) drag.current = { kind: "sel", mode: "start", anchor: s.end };
          else if (s && Math.abs(t - s.end) < tol()) drag.current = { kind: "sel", mode: "end", anchor: s.start };
          else if (onMarker >= 0) grab(onMarker);
          else drag.current = { kind: "sel", mode: "new", anchor: t };
        }
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, e.clientX);
        const p = P.current;
        if (pinch.current && pointers.current.size >= 2) {
          const xs = [...pointers.current.values()];
          const pc = pinch.current;
          const scale = Math.max(10, Math.abs(xs[0] - xs[1])) / pc.d0;
          const span = Math.min(p.duration, Math.max(MIN_SPAN, (pc.e0 - pc.s0) / scale));
          const r = canvas.current!.getBoundingClientRect();
          const frac = ((xs[0] + xs[1]) / 2 - r.left) / r.width;
          let s = pc.c0 - frac * span;
          s = Math.min(Math.max(0, s), p.duration - span);
          p.onView(s, s + span);
          return;
        }
        const d = drag.current;
        if (!d) return;
        const t = timeAt(e.clientX);
        if (d.kind === "sel") {
          const a = Math.min(t, d.anchor), b = Math.max(t, d.anchor);
          if (b - a > 0.002) p.onSelect(a, b, false);
        } else if (d.kind === "marker") {
          // a finger tap wobbles a few pixels: only a real drag moves the marker
          if (!d.moved && Math.abs(e.clientX - d.x0) < 10) return;
          const next = [...p.markers];
          next[d.index] = t;
          d.moved = true;
          p.onMarkers(next, false);
        } else if (d.kind === "beat") {
          p.onBeatMove(d.index, t, false);
        }
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        if (pinch.current) {
          if (pointers.current.size < 2) pinch.current = null;
          drag.current = null;
          return;
        }
        const p = P.current;
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.kind === "sel" && p.selection) p.onSelect(p.selection.start, p.selection.end, true);
        else if (d.kind === "marker") {
          // tapping an existing marker without moving it removes it
          if (!d.moved && !d.created) p.onMarkers(p.markers.filter((_, i) => i !== d.index), true);
          else p.onMarkers([...p.markers].sort((a, b) => a - b), true);
        } else if (d.kind === "beat") p.onBeatMove(d.index, p.beats[d.index], true);
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        pinch.current = null;
        drag.current = null;
      }}
    />
  );
}
