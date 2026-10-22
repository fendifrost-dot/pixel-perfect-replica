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
