/**
 * On-device project library in IndexedDB: project JSON plus the ORIGINAL imported file bytes,
 * so reopening re-decodes the same audio and every chop still points at the same samples.
 * Nothing leaves the device.
 */
import { SCHEMA_VERSION, type Project } from "./types";

const DB = "frost-sampler";
const VERSION = 1;

export interface LibraryEntry {
  key: string;
  name: string;
  savedAt: number;
  project: Project;
}

export interface StoredAudio {
  id: string;
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("projects"))
          d.createObjectStore("projects", { keyPath: "key" });
        if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => (dbp = null));
  }
  return dbp;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
      }),
  );
}

export function migrateProject(raw: unknown): Project {
  const p = raw as Record<string, unknown>;
  if (!p || typeof p !== "object") throw new Error("Not a Frost project");
  const v = p["schemaVersion"];
  if (v !== 1 && v !== SCHEMA_VERSION) throw new Error(`Unsupported project version ${String(v)}`);
  const proj = p as unknown as Project;
  return {
    ...proj,
    schemaVersion: SCHEMA_VERSION,
    beatGrids: proj.beatGrids ?? {},
    export: { ...proj.export, patternRepeats: proj.export?.patternRepeats ?? 4 },
  };
}

const CURRENT = "frost-sampler:current";
export const currentKey = {
  get(): string | null {
    try {
      return localStorage.getItem(CURRENT);
    } catch {
      return null;
    }
  },
  set(k: string) {
    try {
      localStorage.setItem(CURRENT, k);
    } catch {
      /* private mode */
    }
  },
};

export const library = {
  async save(key: string, project: Project) {
    const entry: LibraryEntry = { key, name: project.name, savedAt: Date.now(), project };
    await tx("projects", "readwrite", (s) => s.put(entry));
  },
  async load(key: string): Promise<Project | null> {
    const e = await tx<LibraryEntry>("projects", "readonly", (s) => s.get(key));
    return e ? migrateProject(e.project) : null;
  },
  async list(): Promise<Omit<LibraryEntry, "project">[]> {
    const all = (await tx<LibraryEntry[]>("projects", "readonly", (s) => s.getAll())) ?? [];
    return all
      .map(({ key, name, savedAt }) => ({ key, name, savedAt }))
      .sort((a, b) => b.savedAt - a.savedAt);
  },
  async remove(key: string) {
    await tx("projects", "readwrite", (s) => s.delete(key));
  },
  async putAudio(a: StoredAudio) {
    await tx("audio", "readwrite", (s) => s.put(a));
  },
  async getAudio(id: string): Promise<StoredAudio | undefined> {
    return tx<StoredAudio>("audio", "readonly", (s) => s.get(id));
  },
  /** Ask the browser not to evict our data (Home Screen apps are exempt from Safari's 7-day cap anyway). */
  async requestPersistence(): Promise<boolean> {
    try {
      return (await navigator.storage?.persist?.()) ?? false;
    } catch {
      return false;
    }
  },
};

/** Cheap content fingerprint for verifying a reopened source is byte-identical. */
export async function fingerprint(bytes: ArrayBuffer): Promise<string> {
  try {
    const h = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(h).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // FNV-1a fallback (crypto.subtle needs a secure context)
    let h = 0x811c9dc5;
    const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
    return (h >>> 0).toString(16);
  }
}
