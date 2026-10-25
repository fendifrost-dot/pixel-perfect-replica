import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkKey } from "./key.server";
import { createMemoryStore, setCloudStoreForTests } from "./store.server";
import * as ops from "../frost/ops";
import { encodeWav24 } from "../frost/wav";
import { handleCloud } from "./api.server";

const KEY = "test-key-1234567890";

const memoryStore = createMemoryStore;

describe("key check", () => {
  const req = (init: RequestInit = {}, q = "") => new Request(`https://x.test/mcp${q}`, init);
  it("refuses when the server has no key configured", () => {
    const r = checkKey(req(), undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(503);
  });
  it("accepts bearer, header and query forms", () => {
    expect(checkKey(req({ headers: { authorization: `Bearer ${KEY}` } }), KEY).ok).toBe(true);
    expect(checkKey(req({ headers: { "x-frost-key": KEY } }), KEY).ok).toBe(true);
    expect(checkKey(req({}, `?key=${KEY}`), KEY).ok).toBe(true);
  });
  it("rejects missing and wrong keys with 401", () => {
    for (const r of [
      checkKey(req(), KEY),
      checkKey(req({}, "?key=nope"), KEY),
      checkKey(req({}, `?key=${KEY}x`), KEY),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.status).toBe(401);
    }
  });
});

describe("project operations", () => {
  const base = () => {
    let p = ops.newProject("Test", 92);
    p = ops.addSource(p, {
      id: "src_a",
      name: "loop.wav",
      durationSec: 8,
      sampleRate: 48000,
      channels: 2,
      origin: "imported",
      persistence: "device",
      detectedBpm: null,
    });
    return p;
  };

  it("makes chops from cuts onto consecutive pads", () => {
    const { project, assigned } = ops.makeChops(
      base(),
      "src_a",
      ops.regionsFromCuts([1, 2, 3], 0, 4),
      { bank: "B" },
    );
    expect(assigned.map((a) => a.pad)).toEqual(["B1", "B2", "B3", "B4"]);
    const b3 = project.pads.find((x) => x.id === "B3")!;
    const s = project.slices.find((x) => x.id === b3.sliceId)!;
    expect([s.start, s.end]).toEqual([2, 3]);
  });

  it("sets fit, length and the friendly pad fields", () => {
    let p = ops.makeChops(base(), "src_a", [{ start: 0, end: 2 }], { pads: ["A1"] }).project;
    p = ops.setPad(p, "a1", {
      fit: "repitch",
      lengthBeats: 8,
      plays: "loop",
      chokeGroup: 2,
      fadeOutMs: 30,
      chopName: "Break",
    });
    const pad = p.pads.find((x) => x.id === "A1")!;
    expect(pad).toMatchObject({
      timeMode: "repitch",
      lengthUnit: "bars",
      lengthValue: 2,
      mode: "loop",
      choke: 2,
      release: 0.03,
    });
    expect(ops.summarize(p).pads[0]).toMatchObject({
      pad: "A1",
      fit: "repitch",
      lengthBeats: 8,
      plays: "loop",
      chop: { name: "Break" },
    });
    expect(() => ops.setPad(p, "A1", { volume: 2 })).toThrow(ops.OpsError);
    expect(() => ops.setPad(p, "E1", {})).toThrow(/Unknown pad/);
  });

  it("trims a chop and keeps a fitted pad's speed", () => {
    let p = ops.makeChops(base(), "src_a", [{ start: 0, end: 2 }], { pads: ["A1"] }).project;
    p = ops.setPad(p, "A1", { fit: "stretch", lengthBeats: 8 }); // 2 s over 8 beats
    p = ops.setPad(p, "A1", { chopEnd: 1.5 }); // 25% shorter -> 6 beats, same speed
    const pad = p.pads.find((x) => x.id === "A1")!;
    const s = p.slices.find((x) => x.id === pad.sliceId)!;
    expect([s.start, s.end]).toEqual([0, 1.5]);
    expect(pad).toMatchObject({ lengthUnit: "beats", lengthValue: 6 });
    // past the recording's end is clamped; an explicit length wins over keeping speed
    p = ops.setPad(p, "A1", { chopEnd: 99, lengthBeats: 4 });
    expect(p.slices.find((x) => x.id === pad.sliceId)!.end).toBe(8);
    expect(p.pads.find((x) => x.id === "A1")).toMatchObject({ lengthUnit: "bars", lengthValue: 1 });
    expect(() => ops.setPad(p, "A1", { chopStart: 1, chopEnd: 1 })).toThrow(ops.OpsError);
  });

  it("lays the song out as one long Timeline pattern", () => {
    let p = ops.makeChops(base(), "src_a", [{ start: 0, end: 2 }], { pads: ["A1"] }).project;
    p = ops.addPattern(p, { name: "Verse", bars: 4 }).project;
    const verse = p.currentPatternId;
    p = ops.addHits(p, verse, [{ pad: "A1", step: 0 }, { pad: "A1", step: 3.5, length: 0.5 }]);
    p = ops.setSong(p, [verse, verse, verse]);
    const r = ops.songToTimeline(p);
    const tl = r.project.patterns.find((x) => x.id === r.patternId)!;
    expect(tl.lengthSteps).toBe(16 * 16); // 12 bars rounds up to 16
    expect(tl.notes.map((n) => n.step).sort((a, b) => a - b)).toEqual([0, 3.5, 64, 67.5, 128, 131.5]);
    expect(tl.notes.find((n) => n.step === 67.5)).toMatchObject({ exact: true, length: 0.5 });
    expect(r.project.currentPatternId).toBe(r.patternId);
    expect(() => ops.addHits(p, verse, [{ pad: "A1", step: 0, length: 0.2 }])).toThrow(ops.OpsError);
    expect(() => ops.editPattern(p, verse, { bars: 3 })).toThrow(ops.OpsError);
    expect(ops.editPattern(p, verse, { bars: 32 }).patterns.find((x) => x.id === verse)!.lengthSteps).toBe(512);
  });

  it("adds, replaces and removes hits", () => {
    let p = base();
    p = ops.addHits(p, undefined, [
      { pad: "A1", step: 0 },
      { pad: "A1", step: 8, velocity: 90 },
      { pad: "A2", step: 4, offset: 0.2 },
    ]);
    p = ops.addHits(p, undefined, [{ pad: "A1", step: 8, velocity: 120 }]);
    let hits = ops.summarize(p).patterns[0].hits;
    expect(hits).toHaveLength(3);
    expect(hits.find((h) => h.step === 8)!.velocity).toBe(120);
    expect(() => ops.addHits(p, undefined, [{ pad: "A1", step: 32 }])).toThrow(/outside/);
    p = ops.removeHits(p, undefined, "A1");
    hits = ops.summarize(p).patterns[0].hits;
    expect(hits.map((h) => h.pad)).toEqual(["A2"]);
  });

  it("builds patterns and a song", () => {
    let p = base();
    const r = ops.addPattern(p, { name: "Hook", bars: 1, copyFrom: p.currentPatternId });
    p = ops.setSong(r.project, [p.patterns[0].id, "Hook", "hook"]);
    expect(p.arrangement.map((b) => b.patternId)).toEqual([
      p.patterns[0].id,
      r.patternId,
      r.patternId,
    ]);
    p = ops.deletePattern(p, "Hook");
    expect(p.arrangement).toHaveLength(1);
  });

  it("puts a built-in drum on a pad", () => {
    const kit = ops.kitCatalog()[0];
    const p = ops.addKitDrum(base(), "C5", kit.kit, kit.drums[0].id);
    const pad = p.pads.find((x) => x.id === "C5")!;
    expect(pad.sliceId).toBeTruthy();
    expect(p.sources.some((s) => s.origin === "kit")).toBe(true);
  });
});

describe("sync API and MCP endpoint", () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
    setCloudStoreForTests(store);
    process.env["FROST_MCP_KEY"] = KEY;
  });
  afterEach(() => {
    setCloudStoreForTests(null);
    delete process.env["FROST_MCP_KEY"];
  });

  const cloud = (body: unknown, key = KEY) =>
    handleCloud(
      new Request("https://x.test/api/cloud", {
        method: "POST",
        headers: { "x-frost-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("puts, lists and detects conflicting writes", async () => {
    const p = ops.newProject("Phone beat");
    expect((await cloud({ action: "list" }, "wrong")).status).toBe(401);
    const first = await (
      await cloud({ action: "put", key: "prj_1", project: p, baseUpdatedAt: null })
    ).json();
    expect(first.project.updatedAt).toBe("t1");
    expect((await (await cloud({ action: "list" })).json()).projects[0].key).toBe("prj_1");
    // someone else writes
    await store.put("prj_1", { ...p, name: "Edited by Claude" }, "t1");
    const stale = await cloud({ action: "put", key: "prj_1", project: p, baseUpdatedAt: "t1" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current.name).toBe("Edited by Claude");
  });

  it("runs MCP tools end to end behind the key", async () => {
    const { tools } = await import("../mcp/tools");
    const mcp = (await import("../mcp/index")).default;
    const { createTanStackMcpHandler } = await import("@lovable.dev/mcp-js/stacks/tanstack");
    const { checkKey: ck } = await import("./key.server");
    const handler = createTanStackMcpHandler(mcp, { resourcePath: "/mcp" });
    let id = 0;
    const rpc = async (method: string, params: unknown, key: string | null = KEY) => {
      const req = new Request(`https://x.test/mcp${key ? `?key=${key}` : ""}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const auth = ck(req);
      const res = auth.ok ? await handler({ request: req }) : auth.response;
      const text = await res.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      return { status: res.status, body: JSON.parse(line ? line.slice(5) : text) };
    };
    expect((await rpc("tools/list", {}, null)).status).toBe(401);
    const list = await rpc("tools/list", {});
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      tools.map((t) => t.name).sort(),
    );

    const call = async (name: string, args: unknown) => {
      const r = await rpc("tools/call", { name, arguments: args });
      const res = r.body.result;
      return {
        isError: !!res.isError,
        data: res.content?.[0]?.text?.startsWith("{")
          ? JSON.parse(res.content[0].text)
          : res.content?.[0]?.text,
      };
    };
    const created = await call("create_project", { name: "Claude beat", bpm: 94 });
    const key = created.data.key as string;

    // a WAV with 4 clicks so server-side hit detection has something to find
    const sr = 48000;
    const x = new Float32Array(sr * 4);
    for (const t of [0.5, 1.5, 2.5, 3.5])
      for (let i = 0; i < 1500; i++)
        x[Math.round(t * sr) + i] = Math.exp(-i / 250) * Math.sin(i * 0.8) * 0.8;
    store.audio.set("src_test", encodeWav24([x, x], sr).bytes);
    await store.put(
      key,
      ops.addSource(store.rows.get(key)!.project, {
        id: "src_test",
        name: "clicks.wav",
        durationSec: 4,
        sampleRate: sr,
        channels: 2,
        origin: "imported",
        persistence: "device",
        detectedBpm: null,
      }),
      undefined,
    );

    const found = await call("find_chops", {
      project: "Claude beat",
      recording: "src_test",
      method: "hits",
      apply: "pads",
      startPad: "A1",
    });
    expect(found.isError).toBe(false);
    expect(found.data.cuts).toHaveLength(4);
    expect(found.data.assigned.length).toBeGreaterThanOrEqual(4);

    const padSet = await call("set_pad", {
      project: key,
      pad: "A2",
      fit: "stretch",
      lengthBeats: 1,
    });
    expect(padSet.data.project.pads.find((p: { pad: string }) => p.pad === "A2").fit).toBe(
      "stretch",
    );

    const hits = await call("add_hits", {
      project: key,
      hits: [
        { pad: "A1", step: 0 },
        { pad: "A2", step: 4 },
        { pad: "A1", step: 10, offset: 0.1 },
      ],
    });
    expect(hits.data.project.patterns[0].hits).toHaveLength(3);

    const bad = await call("set_pad", { project: key, pad: "A1", volume: 3 });
    expect(bad.isError).toBe(true);

    const read = await call("get_project", { project: key });
    expect(read.data.project.bpm).toBe(94);
    expect((await call("delete_project", { project: key })).data.ok).toBe(true);
    expect(store.rows.size).toBe(0);
  });
});
