/**
 * Phone ↔ cloud sync. The device copy (IndexedDB) stays the working copy; the cloud copy is what
 * Claude / Grok / ChatGPT edit through the MCP. Rules:
 * - Each local save is pushed with the cloud version it was based on. If the cloud changed meanwhile
 *   (an assistant edited it), the two are merged (merge.ts: each side's changes kept, the phone wins
 *   only where both touched the same thing) and the merge is pushed.
 * - A pull takes every cloud project that changed and isn't dirty here, uploads projects the cloud
 *   doesn't have yet, and removes local copies an assistant deleted.
 * - Audio for imported recordings is uploaded once; missing local audio is downloaded on demand.
 */
import {
  CloudError,
  cloudCall,
  cloudKey,
  downloadAudio,
  uploadAudio,
  type CloudRowJson,
  type CloudSummaryJson,
} from "./cloud";
import { library, migrateProject } from "./persist";
import { keepView, mergeProjects } from "./merge";
import type { Project } from "./types";

export const syncEnabled = () => !!cloudKey.get();

/** ok: pushed (`merged` = the project now includes an assistant's changes the phone should show). */
export type PushResult =
  { ok: true; updatedAt: string; merged?: Project } | { ok: false; error: string };

async function uploadMissingAudio(key: string, p: Project, inCloud: string[]) {
  for (const s of p.sources) {
    if (s.origin !== "imported" || inCloud.includes(s.id)) continue;
    const a = await library.getAudio(s.id);
    if (!a) continue;
    await uploadAudio(s.id, a.bytes, a.type);
    await cloudCall({ action: "audioUploaded", key, sourceId: s.id });
  }
}

// One push at a time per project, so a fast run of edits can't race itself into a false conflict.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** Push the saved local copy of `key`; if an assistant changed the cloud meanwhile, merge and push the merge. */
export function pushProject(key: string): Promise<PushResult> {
  return serial(key, async () => {
    let merged: Project | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const e = await library.entry(key);
      if (!e || e.project.isDemo) return { ok: false, error: "nothing to push" };
      if (!e.dirty && e.cloudUpdatedAt)
        return { ok: true, updatedAt: e.cloudUpdatedAt, ...(merged ? { merged } : {}) };
      try {
        const { project: row } = await cloudCall<{ project: CloudRowJson }>({
          action: "put",
          key,
          project: e.project,
          baseUpdatedAt: e.cloudUpdatedAt ?? null,
        });
        await library.markSynced(key, row.updatedAt, e.savedAt, e.project);
        await uploadMissingAudio(key, e.project, row.audio).catch(() => {
          /* retried on the next push */
        });
        return { ok: true, updatedAt: row.updatedAt, ...(merged ? { merged } : {}) };
      } catch (err) {
        if (!(err instanceof CloudError && err.status === 409 && err.current))
          return { ok: false, error: (err as Error).message };
        const remote = migrateProject(err.current.project);
        merged = mergeProjects(e.base ?? remote, e.project, remote);
        await library.save(key, merged, {
          cloudUpdatedAt: err.current.updatedAt,
          base: remote,
          dirty: true,
        });
      }
    }
    return { ok: false, error: "The cloud copy keeps changing; will retry." };
  });
}

/** Two-way sync of the whole library. Returns keys whose local copy changed and keys removed. */
export async function pullAll(): Promise<{ changed: string[]; removed: string[] }> {
  const { projects } = await cloudCall<{ projects: CloudSummaryJson[] }>({ action: "list" });
  const local = new Map((await library.entries()).map((e) => [e.key, e]));
  const changed: string[] = [];
  const removed: string[] = [];
  for (const c of projects) {
    const l = local.get(c.key);
    if (l && l.cloudUpdatedAt === c.updatedAt) continue;
    const { project: row } = await cloudCall<{ project: CloudRowJson | null }>({
      action: "get",
      key: c.key,
    });
    if (!row) continue;
    const remote = migrateProject(row.project);
    if (l?.dirty) {
      // both sides changed: merge, then push the merge
      await library.save(c.key, mergeProjects(l.base ?? remote, l.project, remote), {
        cloudUpdatedAt: row.updatedAt,
        base: remote,
        dirty: true,
      });
      await pushProject(c.key);
    } else {
      await library.save(c.key, l ? keepView(l.project, remote) : remote, {
        cloudUpdatedAt: row.updatedAt,
        base: remote,
      });
    }
    changed.push(c.key);
  }
  const inCloud = new Set(projects.map((c) => c.key));
  for (const l of local.values()) {
    if (inCloud.has(l.key) || l.project.isDemo) continue;
    if (l.cloudUpdatedAt && !l.dirty) {
      // was synced, now gone from the cloud: deleted by an assistant
      await library.remove(l.key);
      removed.push(l.key);
    } else {
      await pushProject(l.key);
    }
  }
  for (const l of local.values())
    if (l.dirty && inCloud.has(l.key) && !changed.includes(l.key)) await pushProject(l.key);
  return { changed, removed };
}

/** Local delete also deletes the cloud copy (when sync is on). */
export async function deleteEverywhere(key: string) {
  await library.remove(key);
  if (syncEnabled()) await cloudCall({ action: "delete", key }).catch(() => undefined);
}

/** Fetch a recording's audio from the cloud into this device's storage. */
export async function fetchAudioToDevice(
  sourceId: string,
  name: string,
): Promise<ArrayBuffer | null> {
  if (!syncEnabled()) return null;
  const a = await downloadAudio(sourceId).catch(() => null);
  if (!a) return null;
  await library.putAudio({ id: sourceId, name, type: a.type, bytes: a.bytes });
  return a.bytes;
}

/** Check a key against the server without saving it. */
export async function testKey(key: string): Promise<"ok" | "wrong" | "not-set-up" | "offline"> {
  try {
    await cloudCall({ action: "ping" }, key);
    return "ok";
  } catch (e) {
    if (e instanceof CloudError)
      return e.status === 401 ? "wrong" : e.status === 503 ? "not-set-up" : "offline";
    return "offline";
  }
}
