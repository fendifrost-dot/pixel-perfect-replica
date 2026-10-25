import { describe, expect, it } from "vitest";
import { TICKS_PER_STEP, writeMidi } from "./midi";

/** Minimal reader for the files we write: tracks → absolute-tick events. */
function read(b: Uint8Array) {
  const u32 = (o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  expect(tag(0)).toBe("MThd");
  const format = (b[8] << 8) | b[9],
    ntrk = (b[10] << 8) | b[11],
    ppq = (b[12] << 8) | b[13];
  let o = 14;
  const tracks: { tick: number; data: number[] }[][] = [];
  for (let t = 0; t < ntrk; t++) {
    expect(tag(o)).toBe("MTrk");
    const end = o + 8 + u32(o + 4);
    o += 8;
    let tick = 0;
    const ev: { tick: number; data: number[] }[] = [];
    while (o < end) {
      let d = 0;
      for (;;) {
        const c = b[o++];
        d = (d << 7) | (c & 0x7f);
        if (!(c & 0x80)) break;
      }
      tick += d;
      const st = b[o];
      if (st === 0xff) {
        const len = b[o + 2];
        ev.push({ tick, data: [...b.subarray(o, o + 3 + len)] });
        o += 3 + len;
      } else {
        ev.push({ tick, data: [...b.subarray(o, o + 3)] });
        o += 3;
      }
    }
    tracks.push(ev);
  }
  return { format, ntrk, ppq, tracks };
}

describe("midi export", () => {
  it("writes a type-1 file with tempo and one track per part", () => {
    const f = read(
      writeMidi(
        [
          {
            name: "Drums",
            channel: 9,
            notes: [
              { tick: 0, dur: 60, key: 36, vel: 110 },
              { tick: 4 * TICKS_PER_STEP, dur: 60, key: 38, vel: 100 },
            ],
          },
          {
            name: "808",
            channel: 0,
            notes: [
              { tick: 0, dur: 480, key: 33, vel: 127 },
              { tick: 480, dur: 480, key: 33, vel: 127 },
            ],
          },
        ],
        132,
      ),
    );
    expect([f.format, f.ntrk, f.ppq]).toEqual([1, 3, 480]);
    const tempo = f.tracks[0].find((e) => e.data[0] === 0xff && e.data[1] === 0x51)!.data;
    expect(Math.round(60_000_000 / ((tempo[3] << 16) | (tempo[4] << 8) | tempo[5]))).toBe(132);
    const drumOn = f.tracks[1].filter((e) => (e.data[0] & 0xf0) === 0x90);
    expect(drumOn.map((e) => [e.tick, e.data[0] & 15, e.data[1]])).toEqual([
      [0, 9, 36],
      [480, 9, 38],
    ]);
    // repeated note: the first note's off comes before the second note's on at tick 480
    const bass = f.tracks[2]
      .filter((e) => e.tick === 480 && e.data[0] !== 0xff)
      .map((e) => e.data[0] & 0xf0);
    expect(bass).toEqual([0x80, 0x90]);
  });
});
