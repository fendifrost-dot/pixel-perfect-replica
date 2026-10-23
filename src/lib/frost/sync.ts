/**
 * Phone ↔ cloud sync. The device copy (IndexedDB) stays the working copy; the cloud copy is what
 * Claude / Grok / ChatGPT edit through the MCP. Rules:
 * - Each local save is pushed with the cloud version it was based on. If the cloud changed meanwhile
 *   (an assistant edited it), the cloud wins: the push is refused and the cloud copy is pulled.
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
import type { Project } from "./types";

export const syncEnabled = () => !!cloudKey.get();

export type PushResult =
  { ok: true; updatedAt: string } | { ok: false; conflict: Project } | { ok: false; error: string };

async function uploadMissingAudio(key: string, p: Project, inCloud: string[]) {
  for (const s of p.sources) {
    if (s.origin !== "imported" || inCloud.includes(s.id)) continue;
    const a = await library.getAudio(s.id);
    if (!a) continue;
    await uploadAudio(s.id, a.bytes, a.type);
    await cloudCall({ action: "audioUploaded", key, sourceId: s.id });
  }
}

/** Push the saved local copy of `key`. */
export async function pushProject(key: string): Promise<PushResult> {
  const e = await library.entry(key);
  if (!e || e.project.isDemo) return { ok: false, error: "nothing to push" };
  try {
    const { project: row } = await cloudCall<{ project: CloudRowJson }>({
      action: "put",
      key,
      project: e.project,
      baseUpdatedAt: e.cloudUpdatedAt ?? null,
    });
    await library.markSynced(key, row.updatedAt, e.savedAt);
    await uploadMissingAudio(key, e.project, row.audio).catch(() => {
      /* retried on the next push */
    });
    return { ok: true, updatedAt: row.updatedAt };
  } catch (err) {
    if (err instanceof CloudError && err.status === 409 && err.current) {
      const project = migrateProject(err.current.project);
      await library.save(key, project, { cloudUpdatedAt: err.current.updatedAt });
      return { ok: false, conflict: project };
    }
    return { ok: false, error: (err as Error).message };
  }
}

/** Two-way sync of the whole library. Returns keys whose local copy was replaced or removed. */
export async function pullAll(): Promise<{ changed: string[]; removed: string[] }> {
  const { projects } = await cloudCall<{ projects: CloudSummaryJson[] }>({ action: "list" });
  const local = new Map((await library.entries()).map((e) => [e.key, e]));
  const changed: string[] = [];
  const removed: string[] = [];
  for (const c of projects) {
    const l = local.get(c.key);
    if (l && (l.cloudUpdatedAt === c.updatedAt || l.dirty)) continue;
    const { project: row } = await cloudCall<{ project: CloudRowJson | null }>({
      action: "get",
      key: c.key,
    });
    if (!row) continue;
    await library.save(c.key, migrateProject(row.project), { cloudUpdatedAt: row.updatedAt });
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
  for (const l of local.values()) {
    if (!l.dirty || !inCloud.has(l.key)) continue;
    const r = await pushProject(l.key);
    if (!r.ok && "conflict" in r) changed.push(l.key);
  }
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
