# Frost Sampler

Mobile-first pocket sampler: import a song, chop it onto pads, sequence beats, arrange a song, and (soon) export WAVs for LUNA / Pro Tools.

## Setup
```bash
bun install      # or npm install
bun run dev      # http://localhost:8080
```
Open on an iPhone on the same network, or use the hosted preview. Built with React 19, TypeScript, TanStack Start and Tailwind v4. No backend or account required.

## Where things live
- `src/lib/frost/` — data model, service interfaces, prototype audio engine, state store
- `src/components/frost/` — the instrument UI

See **FRONTEND_HANDOFF.md** for what works, what's stubbed, and how to plug in the real audio engine.
