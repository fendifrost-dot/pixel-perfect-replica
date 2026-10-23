import { afterEach, describe, expect, it, vi } from "vitest";
import { supabaseAnon } from "./supabase";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("public MCP data access", () => {
  it("uses the public key without a caller bearer or session credentials", async () => {
    vi.stubEnv("SUPABASE_URL", "https://cloud.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const request = vi.fn(async () => new Response("[]", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    await supabaseAnon().from("projects").select("id");
    expect(request).toHaveBeenCalledTimes(1);
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("apikey")).toBe("sb_publishable_test");
    expect(headers.has("Authorization")).toBe(false);
  });
});