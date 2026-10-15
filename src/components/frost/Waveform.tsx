import { useEffect, useRef } from "react";

interface Props {
  peaks: Float32Array;
  duration: number;
  viewStart: number;
  viewEnd: number;
  selection: { start: number; end: number } | null;
  markers: number[];
  onSelect: (start: number, end: number, final: boolean) => void;
}

/** Canvas waveform with draggable selection handles. Touch surface: no page scroll while dragging. */
export function Waveform({ peaks, duration, viewStart, viewEnd, selection, markers, onSelect }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: "start" | "end" | "new"; anchor: number } | null>(null);
  const sel = useRef(selection);
  sel.current = selection;

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
      const span = viewEnd - viewStart;
      const tx = (t: number) => ((t - viewStart) / span) * w;
      if (selection) {
        g.fillStyle = amber;
        g.globalAlpha = 0.18;
        g.fillRect(tx(selection.start), 0, tx(selection.end) - tx(selection.start), h);
        g.globalAlpha = 1;
      }
      g.fillStyle = wave;
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const t = viewStart + (x / w) * span;
        const i = Math.floor((t / duration) * peaks.length);
        const v = peaks[Math.min(peaks.length - 1, Math.max(0, i))] ?? 0;
        const inSel = selection && t >= selection.start && t <= selection.end;
        g.globalAlpha = inSel ? 1 : 0.5;
        g.fillRect(x, mid - v * mid * 0.92, 1, Math.max(1, v * mid * 1.84));
      }
      g.globalAlpha = 1;
      g.fillStyle = teal;
      for (const m of markers) g.fillRect(tx(m) - 1, 0, 2, h);
      if (selection) {
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
  }, [peaks, duration, viewStart, viewEnd, selection, markers]);

  const timeAt = (clientX: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const t = viewStart + ((clientX - r.left) / r.width) * (viewEnd - viewStart);
    return Math.min(duration, Math.max(0, t));
  };
  const pxPerSec = () => canvas.current!.clientWidth / (viewEnd - viewStart);

  return (
    <canvas
      ref={canvas}
      className="no-touch-scroll block h-40 w-full rounded-md bg-background sm:h-52"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        const t = timeAt(e.clientX);
        const s = sel.current;
        const tol = 22 / pxPerSec();
        if (s && Math.abs(t - s.start) < tol) drag.current = { mode: "start", anchor: s.end };
        else if (s && Math.abs(t - s.end) < tol) drag.current = { mode: "end", anchor: s.start };
        else drag.current = { mode: "new", anchor: t };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const t = timeAt(e.clientX);
        const a = Math.min(t, d.anchor);
        const b = Math.max(t, d.anchor);
        if (b - a > 0.005) onSelect(a, b, false);
      }}
      onPointerUp={() => {
        const s = sel.current;
        if (drag.current && s) onSelect(s.start, s.end, true);
        drag.current = null;
      }}
    />
  );
}
