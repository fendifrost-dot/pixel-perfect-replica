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
- Cloud projects are a separate explicitly shared catalog; preserve device-only IndexedDB storage and never auto-upload its data, because sharing must be intentional.
- Remote MCP uses the SDK-generated TanStack endpoint and lazy public-key client under src/lib/mcp; keep tools read-only and subject to anonymous database policies, because public access must not escalate privileges.
- Audio storage stays private without anonymous object policies while workspace policy blocks public buckets; do not simulate public buckets with signed links or policy workarounds.
- AI slicing sends only an explicitly consented selection through an audio service to a same-origin server endpoint; use a discovered audio-capable Gateway model, keep prompts and keys server-only, validate suggestions, and apply reviewed assignments as one undoable edit without overwriting occupied pads.
