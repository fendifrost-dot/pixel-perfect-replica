/**
 * The one secret that guards Frost Sampler's cloud: FROST_MCP_KEY (a Lovable Cloud secret).
 * Accepted as `Authorization: Bearer <key>`, `x-frost-key: <key>`, or `?key=<key>` (ChatGPT and
 * claude.ai connectors only take a URL, so the query form is what they use).
 */
export type KeyCheck = { ok: true } | { ok: false; response: Response };

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function presentedKey(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const header = request.headers.get("x-frost-key");
  if (header) return header.trim();
  return new URL(request.url).searchParams.get("key");
}

export function checkKey(request: Request, expected = process.env["FROST_MCP_KEY"]): KeyCheck {
  if (!expected || expected.length < 16) {
    return {
      ok: false,
      response: Response.json(
        {
          error:
            "Cloud is not set up: add a FROST_MCP_KEY secret (16+ characters) in Lovable Cloud → Secrets.",
        },
        { status: 503 },
      ),
    };
  }
  const got = presentedKey(request);
  if (!got || !timingSafeEqual(got, expected)) {
    return {
      ok: false,
      response: Response.json(
        { error: "Missing or wrong Frost key." },
        { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="frost-sampler"' } },
      ),
    };
  }
  return { ok: true };
}
