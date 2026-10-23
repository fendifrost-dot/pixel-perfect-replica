<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Frost Sampler architecture
- UI talks to audio only through interfaces in src/lib/frost/services.ts — keeps the engine swappable.
- Audio buffers/peaks live in src/lib/frost/audioStore.ts, never React state — avoids re-render cost and serialization.
- Unimplemented audio features must render an honest Unavailable state, never fake output.
- Project data is versioned via SCHEMA_VERSION in types.ts — bump on breaking changes.
- Built-in drums are synthesized in src/lib/frost/kits.ts (seeded, deterministic — never ship audio assets for them). A drum on a pad is a `kit` source + one slice; it is regenerated on reopen, so the project stays small and the pad behaves like any chop.
- AI slicing sends only an explicitly consented selection through an audio service to a same-origin server endpoint; use a discovered audio-capable Gateway model, keep prompts and keys server-only, validate suggestions, and apply reviewed assignments as one undoable edit without overwriting occupied pads.
- Cloud = private, key-protected sync store for the owner's projects (table `projects`, private bucket `audio`). Only the app's server touches it (service role); anon/authenticated have no grants. Every server entry point (`/mcp`, `/api/cloud`) checks the FROST_MCP_KEY secret first (src/lib/cloud/key.server.ts) — never add a route that reads or writes cloud data without it.
- Phone sync (src/lib/frost/sync.ts) runs only after the owner enters the key in Projects → Cloud sync. Device storage stays the working copy; when both the phone and an assistant changed a project, src/lib/frost/merge.ts merges them item by item (phone wins only where both touched the same thing; view state like the selection is always the phone's). Pushes per project are serialized.
- MCP (src/lib/mcp) has full read/write tools built on the pure edits in src/lib/frost/ops.ts. The route file src/routes/mcp.ts is hand-owned; the mcp-js Vite plugin is deliberately not used because it would regenerate an unguarded /mcp route.
- Audio stays in the private bucket and moves only through short-lived signed URLs issued to key holders.
