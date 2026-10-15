# Frost Sampler — Frontend Handoff

Audience: Claude (or any engineer) implementing the production audio engine.

## Structure
- `src/lib/frost/types.ts` — typed project model (`SCHEMA_VERSION = 1`): sources, slices, pads, notes, patterns, arrangement, tempo, export settings.
- `src/lib/frost/services.ts` — replaceable service interfaces. The UI depends only on these.
- `src/lib/frost/engine.ts` — current prototype Web Audio implementations + honest "unavailable" stubs.
- `src/lib/frost/audioStore.ts` — AudioBuffers and waveform peaks, kept OUTSIDE React state.
- `src/lib/frost/store.tsx` — React context: project state, undo history (50 steps), transport flags.
- `src/lib/frost/demo.ts` — clearly flagged demo project (`isDemo: true`, source `origin: "demo"`, synthetic peaks flagged `demo`).
- `src/components/frost/*` — Workspace shell, TopBar, Sample / Pads / Sequence / Song / Export views.

## Implemented (real)
- Audio import + decode via `AudioContext.decodeAudioData`; real peaks computed from the buffer.
- Waveform zoom/scroll, draggable selection handles, numeric start/end, manual markers, audition.
- Non-destructive slices (start/end into the original source); assign selection to pad; send marker regions to 16 pads.
- Pad trigger: volume, pan, semitone pitch, reverse, one-shot/gate/loop, choke groups 1–4, attack/release, editable velocity, note repeat.
- Classic repitch-to-length (beats/bars at project BPM).
- Step sequencer with 25 ms lookahead scheduler, swing, mute/solo, per-note velocity and timing offset, metronome.
- Note recording: Record + Play, then tap pads → notes land on the current step (always grid-aligned).
- Pattern new/duplicate/clear/length; song arrangement add/duplicate/remove/reorder/label.
- Local metadata save (localStorage) and JSON backup/restore with schema check.

## Demo behavior
The demo project has no audio. Its waveform is synthetic and labelled "Demo waveform · not analysis". Pads with demo chops flash but stay silent.

## Unavailable (honest stubs in engine.ts)
- `sliceService.autoSlice` — transient detection.
- `tempoService.detectBpm` — source BPM detection (`SourceAsset.detectedBpm` stays null). Separate from project BPM.
- Pitch-preserving time-stretch (`timeMode: "stretch"` currently plays at original speed).
- `renderService.renderWav` — offline 24-bit WAV rendering (stereo and per-track stems, common start at 0:00, tail).
- Song-mode playback (transport loops the current pattern).
- Audio persistence: imported audio is `persistence: "session-only"`; bytes are never saved. Use IndexedDB/OPFS if added, then flip the flag.

## Known limitations
- Live-recorded notes use the current step only (no sub-step capture yet), so "quantize off" has no effect when recording.
- Undo coalesces continuous slider gestures into one step.
- iOS requires a user gesture to start audio; `playbackService.resume()` is called on pad taps / play.
- Large files are decoded fully into memory.

## Reusable code from `ai-video-tool`
The owner has an existing `ai-video-tool` repository that may contain audio-analysis (BPM/onset) and WAV-writing utilities. **It has not been reviewed or integrated, and access is not assumed.** Candidate targets:
- BPM / onset detection → `TempoService.detectBpm`, `SliceService.autoSlice`
- WAV encoding (24-bit PCM) → `RenderService.renderWav` (pair with `OfflineAudioContext`)
Evaluate licensing, browser compatibility (no Node APIs) and performance (consider an AudioWorklet / Web Worker) before adopting.
