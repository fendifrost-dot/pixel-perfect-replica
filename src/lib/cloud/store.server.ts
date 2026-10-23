/**
 * Server-only access to the cloud copy of Frost projects (table `projects`) and their audio
 * (private bucket `audio`, object name = source id). Uses the service role; callers must have
 * passed checkKey first.
 */
import { migrateProject } from "../frost/persist";
import type { Project } from "../frost/types";

export const AUDIO_BUCKET = "audio";

export interface CloudRow {
  key: string;
  name: string;
  updatedAt: string;
  project: Project;
  audio: string[];
}
export type CloudSummary = Omit<CloudRow, "project">;

export class ConflictError extends Error {
  constructor(public current: CloudRow) {
    super("The cloud copy changed since it was read.");
  }
}

/** The storage interface the API routes and MCP tools use (swappable for tests). */
export interface CloudStore {
  list(): Promise<CloudSummary[]>;
  get(key: string): Promise<CloudRow | null>;
  /** Write a project. `baseUpdatedAt` = the version it was based on (null = must not exist yet). Throws ConflictError. */
  put(key: string, project: Project, baseUpdatedAt: string | null | undefined): Promise<CloudRow>;
  remove(key: string): Promise<void>;
  markAudio(key: string, sourceId: string): Promise<void>;
  uploadUrl(sourceId: string): Promise<{ url: string; token: string; path: string }>;
  downloadUrl(sourceId: string): Promise<string | null>;
  putAudio(sourceId: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getAudio(sourceId: string): Promise<Uint8Array | null>;
}

type Row = {
  key: string | null;
  name: string;
  updated_at: string;
  project: unknown;
  audio_paths: string[] | null;
};
const toRow = (r: Row): CloudRow => ({
  key: r.key!,
  name: r.name,
  updatedAt: r.updated_at,
  project: migrateProject(r.project),
  audio: r.audio_paths ?? [],
});

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export const supabaseStore: CloudStore = {
  async list() {
    const db = await admin();
    const { data, error } = await db
      .from("projects")
      .select("key,name,updated_at,audio_paths")
      .not("key", "is", null)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({
      key: r.key as string,
      name: r.name,
      updatedAt: r.updated_at,
      audio: r.audio_paths ?? [],
    }));
  },
  async get(key) {
    const db = await admin();
    const { data, error } = await db
      .from("projects")
      .select("key,name,updated_at,project,audio_paths")
      .eq("key", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? toRow(data as Row) : null;
  },
  async put(key, project, base) {
    const db = await admin();
    const now = new Date().toISOString();
    const current = await this.get(key);
    // A row that changed since `base` was read is a conflict; a missing row is (re)created.
    if (base !== undefined && current && current.updatedAt !== base)
      throw new ConflictError(current);
    const fields = {
      key,
      name: project.name,
      schema_version: project.schemaVersion,
      project: project as never,
      updated_at: now,
    };
    const q = current
      ? db.from("projects").update(fields).eq("key", key).eq("updated_at", current.updatedAt)
      : db.from("projects").insert({ ...fields, audio_paths: [] });
    const { data, error } = await q.select("key,name,updated_at,project,audio_paths").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      const now2 = await this.get(key);
      if (now2) throw new ConflictError(now2);
      throw new Error("Project write failed.");
    }
    return toRow(data as Row);
  },
  async remove(key) {
    const db = await admin();
    const { error } = await db.from("projects").delete().eq("key", key);
    if (error) throw new Error(error.message);
  },
  async markAudio(key, sourceId) {
    const db = await admin();
    const cur = await this.get(key);
    if (!cur || cur.audio.includes(sourceId)) return;
    await db
      .from("projects")
      .update({ audio_paths: [...cur.audio, sourceId] })
      .eq("key", key);
  },
  async uploadUrl(sourceId) {
    const db = await admin();
    const { data, error } = await db.storage
      .from(AUDIO_BUCKET)
      .createSignedUploadUrl(sourceId, { upsert: true });
    if (error || !data) throw new Error(error?.message ?? "Could not create upload URL");
    return { url: data.signedUrl, token: data.token, path: data.path };
  },
  async downloadUrl(sourceId) {
    const db = await admin();
    const { data, error } = await db.storage.from(AUDIO_BUCKET).createSignedUrl(sourceId, 3600);
    return error || !data ? null : data.signedUrl;
  },
  async putAudio(sourceId, bytes, contentType) {
    const db = await admin();
    const { error } = await db.storage
      .from(AUDIO_BUCKET)
      .upload(sourceId, bytes, { contentType, upsert: true });
    if (error) throw new Error(error.message);
  },
  async getAudio(sourceId) {
    const db = await admin();
    const { data, error } = await db.storage.from(AUDIO_BUCKET).download(sourceId);
    return error || !data ? null : new Uint8Array(await data.arrayBuffer());
  },
};

/** In-memory store for tests and local development (FROST_DEV_MEMORY_STORE=1). */
export function createMemoryStore(): CloudStore & {
  rows: Map<string, CloudRow>;
  audio: Map<string, Uint8Array>;
} {
  const rows = new Map<string, CloudRow>();
  const audio = new Map<string, Uint8Array>();
  let clock = 0;
  return {
    rows,
    audio,
    async list() {
      return [...rows.values()].map(({ project: _p, ...r }) => r);
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
    async put(key, project, base) {
      const cur = rows.get(key);
      if (base !== undefined && cur && cur.updatedAt !== base) throw new ConflictError(cur);
      const row = {
        key,
        name: project.name,
        updatedAt: `t${++clock}`,
        project,
        audio: cur?.audio ?? [],
      };
      rows.set(key, row);
      return row;
    },
    async remove(key) {
      rows.delete(key);
    },
    async markAudio(key, id) {
      const r = rows.get(key);
      if (r && !r.audio.includes(id)) r.audio = [...r.audio, id];
    },
    async uploadUrl(id) {
      return { url: `/api/cloud-dev-audio?id=${id}`, token: "dev", path: id };
    },
    async downloadUrl(id) {
      return audio.has(id) ? `/api/cloud-dev-audio?id=${id}` : null;
    },
    async putAudio(id, bytes) {
      audio.set(id, bytes);
    },
    async getAudio(id) {
      return audio.get(id) ?? null;
    },
  };
}

let override: CloudStore | null = null;
let devStore: CloudStore | null = null;
/** The active store (tests can swap in a fake; local dev can opt into memory). */
export const cloudStore = (): CloudStore => {
  if (override) return override;
  if (process.env["FROST_DEV_MEMORY_STORE"] === "1" && !process.env["SUPABASE_SERVICE_ROLE_KEY"])
    return (devStore ??= createMemoryStore());
  return supabaseStore;
};
export const setCloudStoreForTests = (s: CloudStore | null) => {
  override = s;
};

/** Read → edit → write with optimistic concurrency, retrying once if someone else wrote in between. */
export async function editProject(key: string, fn: (p: Project) => Project): Promise<CloudRow> {
  const store = cloudStore();
  for (let attempt = 0; ; attempt++) {
    const row = await store.get(key);
    if (!row) throw new Error(`No project with key "${key}". Use list_projects to see keys.`);
    try {
      return await store.put(key, fn(row.project), row.updatedAt);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 2) continue;
      throw e;
    }
  }
}
