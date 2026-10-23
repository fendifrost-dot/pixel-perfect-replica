/**
 * Three-way merge of a project edited on the phone (local) and by an assistant (remote), both
 * starting from the last copy they agreed on (base). Pure; used by sync.ts.
 *
 * - What only one side changed is kept. What both changed: the phone wins (the person is looking at it).
 * - Lists with ids (pads, slices, sources, patterns, arrangement) merge item by item; per-recording maps
 *   (chop markers, beat markers) merge per recording.
 * - View state (selection, open recording / pad / bank / pattern) is always the phone's.
 */
import type { Project } from "./types";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Pick a value: the side that changed from base; both changed → local. */
function pick<T>(base: T | undefined, local: T | undefined, remote: T | undefined): T | undefined {
  if (same(local, base)) return remote;
  return local;
}

function mergeById<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
  const b = new Map(base.map((x) => [x.id, x]));
  const l = new Map(local.map((x) => [x.id, x]));
  const r = new Map(remote.map((x) => [x.id, x]));
  const order = [...local.map((x) => x.id), ...remote.map((x) => x.id).filter((id) => !l.has(id))];
  const out: T[] = [];
  for (const id of order) {
    const v = pick(b.get(id), l.get(id), r.get(id));
    // pick() returning undefined = deleted on the side that changed it
    if (v !== undefined) out.push(v);
  }
  return out;
}

function mergeMap<V>(
  base: Record<string, V>,
  local: Record<string, V>,
  remote: Record<string, V>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
    const v = pick(base[k], local[k], remote[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const VIEW_FIELDS = [
  "selection",
  "activeSourceId",
  "selectedPadId",
  "bank",
  "currentPatternId",
] as const;

export function mergeProjects(base: Project, local: Project, remote: Project): Project {
  const out: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]) as Set<keyof Project>;
  for (const k of keys) out[k] = pick(base[k], local[k], remote[k]);
  const m = out as unknown as Project;
  m.pads = mergeById(base.pads, local.pads, remote.pads);
  m.slices = mergeById(base.slices, local.slices, remote.slices);
  m.sources = mergeById(base.sources, local.sources, remote.sources);
  m.patterns = mergeById(base.patterns, local.patterns, remote.patterns).map((pt) => {
    const b = base.patterns.find((x) => x.id === pt.id);
    const l = local.patterns.find((x) => x.id === pt.id);
    const r = remote.patterns.find((x) => x.id === pt.id);
    if (!b || !l || !r) return pt;
    return {
      ...pt,
      notes: mergeById(b.notes, l.notes, r.notes),
      lanes: mergeLanes(b.lanes, l.lanes, r.lanes),
    };
  });
  m.arrangement = mergeById(base.arrangement, local.arrangement, remote.arrangement);
  m.markers = mergeMap(base.markers, local.markers, remote.markers);
  m.beatGrids = mergeMap(base.beatGrids, local.beatGrids, remote.beatGrids);
  for (const f of VIEW_FIELDS) (m as unknown as Record<string, unknown>)[f] = local[f];
  if (!m.patterns.some((p) => p.id === m.currentPatternId))
    m.currentPatternId = m.patterns[0]?.id ?? m.currentPatternId;
  return m;
}

function mergeLanes(
  base: Project["patterns"][number]["lanes"],
  local: typeof base,
  remote: typeof base,
) {
  const asId = (l: typeof base) => l.map((x) => ({ ...x, id: x.padId }));
  return mergeById(asId(base), asId(local), asId(remote)).map(({ id: _id, ...rest }) => rest);
}

/** Take a newer cloud copy while keeping what the phone is looking at. */
export function keepView(current: Project, incoming: Project): Project {
  const out = { ...incoming } as Record<string, unknown>;
  for (const f of VIEW_FIELDS) out[f] = current[f];
  const p = out as unknown as Project;
  if (!p.patterns.some((x) => x.id === p.currentPatternId))
    p.currentPatternId = p.patterns[0]?.id ?? p.currentPatternId;
  if (p.activeSourceId && !p.sources.some((s) => s.id === p.activeSourceId))
    p.activeSourceId = p.sources[0]?.id ?? null;
  return p;
}
