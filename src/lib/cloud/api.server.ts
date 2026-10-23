/**
 * Phone ↔ cloud sync endpoint (POST /api/cloud, JSON body { action, ... }), guarded by FROST_MCP_KEY.
 * The app sends the key the user typed in Projects → Cloud sync.
 */
import { z } from "zod";
import { checkKey } from "./key.server";
import { ConflictError, cloudStore } from "./store.server";
import { migrateProject } from "../frost/persist";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ping") }),
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("get"), key: z.string().min(1) }),
  z.object({
    action: z.literal("put"),
    key: z.string().min(1),
    project: z.unknown(),
    baseUpdatedAt: z.string().nullable(),
  }),
  z.object({ action: z.literal("delete"), key: z.string().min(1) }),
  z.object({ action: z.literal("audioUploadUrl"), sourceId: z.string().regex(/^[\w-]+$/) }),
  z.object({
    action: z.literal("audioUploaded"),
    key: z.string().min(1),
    sourceId: z.string().regex(/^[\w-]+$/),
  }),
  z.object({ action: z.literal("audioDownloadUrl"), sourceId: z.string().regex(/^[\w-]+$/) }),
]);

export async function handleCloud(request: Request): Promise<Response> {
  const auth = checkKey(request);
  if (!auth.ok) return auth.response;
  let b: z.infer<typeof body>;
  try {
    b = body.parse(await request.json());
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  const store = cloudStore();
  try {
    switch (b.action) {
      case "ping":
        return Response.json({ ok: true });
      case "list":
        return Response.json({ projects: await store.list() });
      case "get":
        return Response.json({ project: await store.get(b.key) });
      case "put":
        return Response.json({
          project: await store.put(b.key, migrateProject(b.project), b.baseUpdatedAt),
        });
      case "delete":
        await store.remove(b.key);
        return Response.json({ ok: true });
      case "audioUploadUrl":
        return Response.json(await store.uploadUrl(b.sourceId));
      case "audioUploaded":
        await store.markAudio(b.key, b.sourceId);
        return Response.json({ ok: true });
      case "audioDownloadUrl":
        return Response.json({ url: await store.downloadUrl(b.sourceId) });
    }
  } catch (e) {
    if (e instanceof ConflictError)
      return Response.json({ error: "conflict", current: e.current }, { status: 409 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
