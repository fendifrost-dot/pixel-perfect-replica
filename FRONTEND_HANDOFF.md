# Frost Sampler — Handoff

Audience: Claude (or any engineer) continuing the app. What to verify on a real iPhone, and how,
is in **DEVICE_PROOF.md**.

## Structure
- `src/lib/frost/types.ts` — project model (`SCHEMA_VERSION = 2`; v1 projects migrate in `persist.ts`).
- `src/lib/frost/timing.ts` — **pure** tempo/grid math: quantize, swing, recording positions, song/pattern
  sections, `eventsInRange` (the one schedule both live playback and export use), fit-to-length plans.
- `src/lib/frost/voice.ts` — one pad hit as Web Audio nodes; used by the live `AudioContext` *and* the
  export `OfflineAudioContext`. Also bakes pitch-preserving stretches.
- `src/lib/frost/engine.ts` — live side: import/rehydrate, pads, lookahead transport, auto-slice, tempo suggestion, backup.
- `src/lib/frost/render.ts` — offline 24-bit WAV export (mix + one file per pad, all aligned at 0:00, same length).
- `src/lib/frost/stretch.ts` — WSOLA time-stretch (pure). `analysis.ts` — onsets, tempo suggestion, beat grid, waveform columns (pure). `wav.ts` — 24-bit encode / decode (pure).
- `src/lib/frost/persist.ts` — IndexedDB project library + original audio bytes; migration.
- `src/lib/frost/selftest.ts` — on-device proof checks (Export → Device check).
- `src/lib/frost/store.tsx` — React context: project, undo, transport flags, autosave, reopen-on-launch.
- `src/components/frost/*` — Sample / Pads / Sequence / Song / Export views.
- `public/manifest.webmanifest` + icons — Add to Home Screen.

## Implemented
- Import MP3/WAV (anything Safari decodes). Original bytes saved in IndexedDB; projects autosave and reopen on launch.
- Waveform drawn from real samples at any zoom; pinch zoom; select / chop-marker / beat-marker modes.
- Auto-slice: transients (sensitivity), equal divisions, every N beats of the beat grid. Manual markers: tap to add, drag, tap to delete.
- Editable beat markers per recording (from typed / tapped / suggested source BPM, then dragged). Source BPM is separate from project BPM.
- 16 pads × 4 banks; volume, pan, pitch, velocity, attack/release, one-shot/gate/loop, choke, reverse.
- Musical length in beats or bars with two separate methods: pitch-preserving stretch (WSOLA, baked ahead) and classic repitch.
- Performance quantize (off, 1/8, 1/16, 1/32) and MPC-style swing, applied **non-destructively** at playback/export. Live recording stores the played position (step + sub-step offset), compensated for output latency plus a per-device calibration offset.
- Pattern loop and whole-song playback; song export.
- Export: stereo mix + per-pad tracks, 24-bit, 44.1/48 kHz, pattern×N or song, release tail. Share sheet (Save to Files / AirDrop) or downloads.
- Device check: export timing to the sample, stems-sum-to-mix, pad boundaries, save → reopen → re-decode.

## Evidence so far (headless Chromium on Linux, not an iPhone)
Full workflow driven by Playwright on a generated 96 BPM drum loop: import → 24 transient markers → tempo
suggestion 95.9 → 16 slices to bank A → stretch fit → live recording → mix + 4 tracks → device check
all PASS (worst hit timing error 0.59 samples @48k, 1.09 @44.1k; stems sum to mix exactly; every pad starts
and ends ≤ −64 dBFS; reopen field-identical and audio sample-exact). **None of this has run on iOS Safari yet.**

## Known limits / design decisions
- Gate/loop hits in a sequence hold until the next hit on the same pad (no note-length editing yet).
- Live recording has no sub-step capture of release (gate length) and note repeat is not tempo-locked to the transport.
- WSOLA is tight for drums and phrases; at large ratios (> ~1.6× / < ~0.6×) it can double transients or sound grainy.
- Live choke fades with `setTargetAtTime`; export uses a linear 8 ms fade — both cut at the same time.
- Export memory: each track renders its own `OfflineAudioContext` (float, full length). Long songs × many pads may hit iOS tab memory limits — measure on device.
- No service worker: the Home Screen app needs a connection to load the page; audio and projects stay on device.
- Backups (`.frost.json`) contain no audio; audio lives in the browser's IndexedDB on that device.
