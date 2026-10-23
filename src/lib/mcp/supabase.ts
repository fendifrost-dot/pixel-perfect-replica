import { createClient } from "@supabase/supabase-js";

// Lazy configuration: extraction must work without server environment variables.
export function supabaseAnon() {
  const env = process.env;
  const url = env["SUPABASE_URL"] ?? env["VITE_SUPABASE_URL"];
  let key = env["SUPABASE_PUBLISHABLE_KEY"] ?? env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  if (!key && env["SUPABASE_PUBLISHABLE_KEYS"]) {
    try {
      const keys: unknown = JSON.parse(env["SUPABASE_PUBLISHABLE_KEYS"] ?? "{}");
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        key = Object.values(keys).find((value): value is string => typeof value === "string" && value.startsWith("sb_publishable_"));
      }
    } catch { /* Legacy configuration may still be available. */ }
  }
  key ??= env["SUPABASE_ANON_KEY"] ?? env["VITE_SUPABASE_ANON_KEY"];
  if (!url || !key) throw new Error("Cloud public access configuration is unavailable.");
  const publicKey = key;
  return createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (publicKey.startsWith("sb_") && headers.get("Authorization") === `Bearer ${publicKey}`) headers.delete("Authorization");
        headers.set("apikey", publicKey);
        return fetch(input, { ...init, headers });
      },
    },
  });
}