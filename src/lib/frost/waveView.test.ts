import { describe, expect, it } from "vitest";
import {
  beatGrid,
  gridLines,
  isTypingTarget,
  nextEmptyPad,
  timeGrid,
  timeLabel,
  viewForSelection,
  zoomAnchor,
  zoomCommand,
  zoomView,
} from "./waveView";

describe("zoomCommand (Pro Tools keys)", () => {
  it("maps T / R to zoom in / out", () => {
    expect(zoomCommand({ key: "t" })).toBe("in");
    expect(zoomCommand({ key: "T", shiftKey: true })).toBe("in");
    expect(zoomCommand({ key: "r" })).toBe("out");
  });
  it("maps Cmd/Ctrl + ] and [", () => {
    expect(zoomCommand({ key: "]", metaKey: true })).toBe("in");
    expect(zoomCommand({ key: "[", metaKey: true })).toBe("out");
    expect(zoomCommand({ key: "]", ctrlKey: true })).toBe("in");
    expect(zoomCommand({ key: "[", code: "BracketLeft", ctrlKey: true })).toBe("out");
  });
  it("maps Option+A / Option+F by physical key, whatever character Option types", () => {
    expect(zoomCommand({ key: "å", code: "KeyA", altKey: true })).toBe("all");
    expect(zoomCommand({ key: "ƒ", code: "KeyF", altKey: true })).toBe("selection");
  });
  it("leaves browser and unrelated shortcuts alone", () => {
    expect(zoomCommand({ key: "r", metaKey: true })).toBeNull();
    expect(zoomCommand({ key: "t", ctrlKey: true })).toBeNull();
    expect(zoomCommand({ key: "a" })).toBeNull();
    expect(zoomCommand({ key: "]" })).toBeNull();
    expect(zoomCommand({ key: "Enter" })).toBeNull();
    expect(zoomCommand({ key: "å", code: "KeyA", altKey: true, metaKey: true })).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("is true for text entry, false for sliders, buttons and non-elements", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("zoomView", () => {
  it("zooms in around the anchor and keeps it at the same screen position", () => {
    const [s, e] = zoomView([0, 100], 100, 2, 25);
    expect(e - s).toBeCloseTo(50);
    expect((25 - s) / (e - s)).toBeCloseTo(0.25);
  });
  it("zooming in then out by the same step returns to the start", () => {
    const a = zoomView([10, 30], 100, 1.5, 20);
    const b = zoomView(a, 100, 1 / 1.5, 20);
    expect(b[0]).toBeCloseTo(10);
    expect(b[1]).toBeCloseTo(30);
  });
  it("never leaves the recording or passes the limits", () => {
    expect(zoomView([0, 100], 100, 0.5)).toEqual([0, 100]);
    const far = zoomView([99.9, 100], 100, 0.25, 100);
    expect(far[1]).toBeLessThanOrEqual(100 + 1e-9);
    expect(far[0]).toBeGreaterThanOrEqual(0);
    const tight = zoomView([5, 5.03], 100, 1000, 5.01);
    expect(tight[1] - tight[0]).toBeCloseTo(0.02);
  });
  it("works for any duration, including one shorter than the minimum span", () => {
    const [s, e] = zoomView([0, 0.01], 0.01, 4);
    expect(s).toBe(0);
    expect(e).toBeCloseTo(0.01);
  });
});

describe("zoomAnchor / viewForSelection", () => {
  it("anchors on the selection start when visible, else the middle", () => {
    expect(zoomAnchor([0, 10], { start: 3, end: 4 })).toBe(3);
    expect(zoomAnchor([5, 10], { start: 3, end: 4 })).toBe(7.5);
    expect(zoomAnchor([5, 10], null)).toBe(7.5);
  });
  it("fills the view with the selection, inside the recording", () => {
    const [s, e] = viewForSelection({ start: 10, end: 20 }, 100);
    expect(s).toBeLessThan(10);
    expect(e).toBeGreaterThan(20);
    expect(e - s).toBeCloseTo(11);
    const edge = viewForSelection({ start: 0, end: 4 }, 100);
    expect(edge[0]).toBe(0);
    const whole = viewForSelection({ start: 0, end: 100 }, 100);
    expect(whole).toEqual([0, 100]);
  });
});

describe("timeGrid", () => {
  it("labels round times at least the minimum distance apart", () => {
    for (const [a, b, w] of [
      [0, 660, 1100],
      [0, 5, 400],
      [12.3, 12.38, 900],
      [100, 3700, 320],
    ] as const) {
      const lines = timeGrid(a, b, w);
      const majors = lines.filter((l) => l.major);
      expect(majors.length).toBeGreaterThan(0);
      expect(majors.every((l) => l.label)).toBe(true);
      const px = (t: number) => ((t - a) / (b - a)) * w;
      for (let i = 1; i < majors.length; i++)
        expect(px(majors[i]!.t) - px(majors[i - 1]!.t)).toBeGreaterThanOrEqual(90 - 1e-6);
      for (const l of lines) {
        expect(l.t).toBeGreaterThanOrEqual(a - 1e-6);
        expect(l.t).toBeLessThanOrEqual(b + 1e-6);
      }
      for (let i = 1; i < lines.length; i++)
        expect(px(lines[i]!.t) - px(lines[i - 1]!.t)).toBeGreaterThanOrEqual(8 - 1e-6);
    }
  });
  it("draws more lines as you zoom in on the same spot", () => {
    const wide = timeGrid(0, 600, 1000).filter((l) => l.t >= 10 && l.t <= 20).length;
    const close = timeGrid(10, 20, 1000).length;
    expect(close).toBeGreaterThan(wide);
  });
  it("is empty for an empty view", () => {
    expect(timeGrid(5, 5, 800)).toEqual([]);
    expect(timeGrid(0, 10, 0)).toEqual([]);
  });
});

describe("timeLabel", () => {
  it("shows the decimals the spacing needs", () => {
    expect(timeLabel(75, 5)).toBe("1:15");
    expect(timeLabel(5, 1)).toBe("0:05");
    expect(timeLabel(75.5, 0.5)).toBe("1:15.5");
    expect(timeLabel(3.25, 0.05)).toBe("0:03.25");
    expect(timeLabel(3.125, 0.005)).toBe("0:03.125");
  });
});

describe("beatGrid", () => {
  const beats = (bpm: number, n: number, t0 = 0) =>
    Array.from({ length: n }, (_, i) => t0 + (i * 60) / bpm);
  it("labels bars by number and draws beats between them", () => {
    const lines = beatGrid(beats(120, 64), 0, 8, 1000);
    const bars = lines.filter((l) => l.major);
    expect(bars.map((l) => l.label)).toEqual(["1", "2", "3", "4", "5"]);
    expect(bars.map((l) => l.t)).toEqual([0, 2, 4, 6, 8]);
    expect(lines.filter((l) => !l.major && l.label).map((l) => l.label)).toContain("1.2");
  });
  it("thins to every Nth bar when zoomed out, for any tempo", () => {
    for (const bpm of [70, 90, 132, 174]) {
      const b = beats(bpm, 1200);
      const end = b[b.length - 1]!;
      const lines = beatGrid(b, 0, end, 400);
      const px = (t: number) => (t / end) * 400;
      expect(lines.every((l) => l.major)).toBe(true);
      for (let i = 1; i < lines.length; i++)
        expect(px(lines[i]!.t) - px(lines[i - 1]!.t)).toBeGreaterThanOrEqual(44 - 1e-6);
    }
  });
  it("splits beats into 16ths when zoomed in", () => {
    const lines = beatGrid(beats(120, 16), 0, 1, 1000);
    const ts = lines.map((l) => +l.t.toFixed(4));
    expect(ts).toContain(0.125);
    expect(ts).toContain(0.375);
  });
  it("follows dragged (uneven) beat markers", () => {
    const b = [0, 0.5, 1.1, 1.5, 2, 2.5, 3, 3.5, 4];
    const lines = beatGrid(b, 0, 4, 2000);
    expect(lines.some((l) => Math.abs(l.t - 1.1) < 1e-9)).toBe(true);
    expect(lines.some((l) => Math.abs(l.t - 0.8) < 1e-9)).toBe(true);
  });
  it("starts counting bars from the first marker, wherever it sits", () => {
    const lines = beatGrid(beats(100, 40, 3.2), 0, 10, 1000);
    expect(lines.find((l) => l.major)).toMatchObject({ t: 3.2, label: "1" });
  });
});

describe("gridLines", () => {
  it("uses beats when there are markers, the clock otherwise", () => {
    expect(gridLines([0, 0.5, 1, 1.5, 2], 0, 2, 1000)[0]!.label).toBe("1");
    expect(gridLines([], 0, 2, 1000)[0]!.label).toBe("0:00.0");
    expect(gridLines(null, 0, 2, 1000).length).toBeGreaterThan(0);
  });
});

describe("nextEmptyPad", () => {
  const ids = ["A1", "A2", "A3", "A4"];
  const pads = (full: string[]) =>
    ids.map((id) => ({ id, sliceId: full.includes(id) ? "s" : null }));
  it("finds the next empty pad after the current one, wrapping", () => {
    expect(nextEmptyPad(pads(["A1"]), ids, "A1")).toBe("A2");
    expect(nextEmptyPad(pads(["A1", "A2", "A3"]), ids, "A2")).toBe("A4");
    expect(nextEmptyPad(pads(["A2", "A3", "A4"]), ids, "A4")).toBe("A1");
  });
  it("is null when every other pad is full", () => {
    expect(nextEmptyPad(pads(ids), ids, "A1")).toBeNull();
  });
});
