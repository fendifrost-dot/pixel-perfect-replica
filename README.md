# Frost Sampler

Mobile-first pocket sampler: import a song, chop it onto 16 pads, fit chops to your BPM (time-stretch or classic repitch), play and record a beat, and export a 24-bit stereo mix plus aligned per-pad WAVs for LUNA / Pro Tools. Runs in Safari and installs to the iPhone Home Screen; audio and projects stay on the device.

## Setup
```bash
bun install      # or npm install
bun run dev      # http://localhost:8080
```
Open on an iPhone on the same network, or use the hosted preview. Built with React 19, TypeScript, TanStack Start and Tailwind v4. No backend or account required.

## Where things live
- `src/lib/frost/` — data model, service interfaces, prototype audio engine, state store
- `src/components/frost/` — the instrument UI

See **FRONTEND_HANDOFF.md** for architecture and limits, and **DEVICE_PROOF.md** for the on-iPhone verification checklist.

## Tests
```bash
bun run test     # pure timing / WAV / analysis / stretch / migration tests
```
On device: Export → **Run device check**.
