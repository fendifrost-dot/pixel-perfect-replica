/**
 * Client for the key-protected cloud (POST /api/cloud). The key is the FROST_MCP_KEY secret the owner
 * typed into Projects → Cloud sync; it is kept in this device's localStorage only.
 */
import type { Project } from "./types";

const KEY = "frost-sampler:cloud-key";

export const cloudKey = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(k: string | null) {
    try {
      if (k) localStorage.setItem(KEY, k);
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
  },
};

export interface CloudRowJson {
  key: string;
  name: string;
  updatedAt: string;
  project: Project;
  audio: string[];
}
export type CloudSummaryJson = Omit<CloudRowJson, "project">;

export class CloudError extends Error {
  constructor(
    message: string,
    public status: number,
    public current?: CloudRowJson,
  ) {
    super(message);
  }
}

export async function cloudCall<T>(
  body: Record<string, unknown>,
  key = cloudKey.get(),
): Promise<T> {
  if (!key) throw new CloudError("Cloud sync is off.", 0);
  const res = await fetch("/api/cloud", {
    method: "POST",
    headers: { "content-type": "application/json", "x-frost-key": key },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new CloudError(json.error ?? `Cloud error ${res.status}`, res.status, json.current);
  return json as T;
}

export async function uploadAudio(sourceId: string, bytes: ArrayBuffer, type: string) {
  const { url } = await cloudCall<{ url: string }>({ action: "audioUploadUrl", sourceId });
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": type || "application/octet-stream", "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) throw new CloudError(`Audio upload failed (${res.status})`, res.status);
}

export async function downloadAudio(
  sourceId: string,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const { url } = await cloudCall<{ url: string | null }>({ action: "audioDownloadUrl", sourceId });
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "" };
}
