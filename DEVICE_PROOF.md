# Device proof — Frost Sampler on a real iPhone

Goal: prove the full import → chop → pads → BPM fit → perform → export workflow **on an iPhone**
before adding features, then estimate the remaining work from what actually happened.

Status: the code is **written and verified in headless Chromium on Linux only**
(see FRONTEND_HANDOFF.md → Evidence). It has **not** run on iOS Safari. Nothing below is verified
until someone runs it on the phone and reports real output.

## 0. Make it live (needs Lovable, not code)
1. Merge the PR for branch `claude/iphone-audio-sampler-qdh0k3` into `main` (Lovable syncs `main`).
2. In Lovable: **Publish**. (No database, no edge functions, no secrets are involved.)
3. Check: open `<published-url>/manifest.webmanifest` — expect HTTP 200 and JSON with `"name": "Frost Sampler"`.
   A 404 means the publish didn't pick up the merge.

## 1. Install on the iPhone
Safari → published URL → Share → **Add to Home Screen** → open it from the Home Screen icon
(Home Screen apps keep their storage; plain Safari tabs can be cleared after 7 days unused).

## 2. Run the built-in check first
Use any MP3 or WAV from Files. Sample → **Import audio**. Then Export → **Run device check** → **Copy report**.

Expected (each line must say PASS):

| Check | Pass means |
|---|---|
| Audio device | informational: sample rate (expect 48000 or 44100) and latencies |
| Export files ×3 | 4 files, 24-bit, identical frame counts (48k: **269891**, 44.1k: **247962**) |
| Hit timing in mix ×3 | worst error ≤ 1.5 samples (Chromium measured 0.59 / 0.59 / 1.09) |
| Tracks sum to mix ×3 | ≤ −80 dBFS (Chromium: −240) |
| Pad boundaries | start and end step quieter than −40 / −34 dBFS on every assigned pad |
| Project reopens identically / Audio … sample-exact | max diff 0.0e+0 |

Different frame counts or a FAIL is a finding — report it as-is, don't adjust thresholds to make it pass.

## 3. Manual workflow (the part a script can't judge)
Use a real song you'd sample.

1. **Import + zoom**: pinch-zoom to a single kick; the waveform stays sharp, not blocky.
2. **Chop**: Auto-slice (Transients) → markers land on hits. Drag one, tap one to delete. *Chop markers → To bank A.*
3. **Beat markers**: Tap/Suggest the source BPM → *Beat markers from selection start* → drag a marker onto a downbeat.
4. **Fit**: on a 1-bar loop pad set Length 1 bar → try **Time-stretch** and **Classic repitch** at a project BPM ±10 from the source. Stretch keeps pitch; repitch shifts it.
5. **Pads**: drum fast with two thumbs. Note: any missed taps? Any delay you can feel? Clicks at chop starts/ends?
6. **Record**: Metronome on, Play, Record, play 2 bars. Quantize off → hits sound as played; Quantize 1/16 + swing 60 → hits snap and swing. If everything lands consistently late/early, set *Record timing offset* (Pads) and re-test — note the value.
7. **Ring/silent switch**: with the switch on silent, pads should still sound.
8. **Reopen**: swipe the app away, reopen from Home Screen → same project, pads play, chops intact.
9. **Export**: Mix + separate tracks, pattern ×4 → Render → **Share → Save to Files** (or AirDrop to the Mac).
10. **DAW**: in LUNA or Pro Tools set the session to the project BPM and export sample rate, import all files at bar 1. Kick transients sit on the grid; tracks line up with the mix (flip polarity on the mix: tracks + inverted mix ≈ silence).

## 4. Report back
- The copied device-check report.
- iPhone model, iOS version, Home Screen or Safari tab.
- For each manual step: OK / problem (what you heard or saw).
- Render time for a 4-bar ×4 export with all tracks, and the longest export you tried (did it crash?).
- Record timing offset you settled on.

## 5. Estimate (prior, to be revised by the report)
| If the report shows… | Remaining work to "solid daily tool" |
|---|---|
| All PASS, only taste issues | ~1–2 focused sessions: note-length/gate editing, tempo-locked note repeat, offline service worker |
| Pad latency or missed taps | +1–2 sessions: move triggering off React (no state on tap path), AudioWorklet voice engine |
| Export crashes / slow on long songs | +1 session: stream stems in one multi-channel render, chunked WAV encoding |
| Timing FAILs on iOS only | +1–2 sessions: Safari `start()` rounding / resampling investigation, possibly own resampler |
| Stretch quality unacceptable | +2–3 sessions: phase-vocoder or a WASM stretcher (e.g. Rubber Band / Signalsmith) |

Do not start feature expansion (effects, sampling from mic, MIDI, more banks) until sections 2–3 come back clean.
