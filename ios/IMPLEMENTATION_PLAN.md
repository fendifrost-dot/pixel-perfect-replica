# Frost Sampler native iOS — implementation plan

Date: 24 October 2026. This is the development direction Fendi approved in the Sampler sections of [ai-video-tool#379](https://github.com/fendifrost-dot/ai-video-tool/pull/379) (`docs/research/IOS_HF_FEASIBILITY_AUDIT_2026-10-24.md`, sections 1.2, 3.2, 4, and 6). The audit's own milestone order still asks for a Home Screen device check of the existing PWA before treating a native engine as the replacement. This branch does not make that claim. It starts the native client beside the PWA: same project JSON, same chop math, same cloud contract, no change to the web app.

Coordination with other agents stays on GitHub until [fendi-control-center#78](https://github.com/fendifrost-dot/fendi-control-center/issues/78) has an authenticated ingest path. That issue is a messaging bug (ChatGPT research not reaching Agent Hub or Grok). This branch does not post into Agent Hub, does not impersonate ChatGPT or Grok, and does not put a bearer token in the app, the repo, or this document. The pull request is the record.

## Role of the app

The iPhone app is the instrument. Import, waveform, chops, BPM, 16 pads, pattern playback, and 24-bit export run on device. The Lovable app remains the sync store and the MCP host (`/api/cloud`, `/mcp`), both gated by `FROST_MCP_KEY`. The native app will be another client of that API. It will not open Postgres and it will not embed the Supabase client. Audio bytes stay in the private bucket and move only through signed URLs the server already issues.

Instrument isolation (`facebook/sam-audio-large` and the GGUF conversion) stays off the pad path. It is gated, untested on these songs, and not a Core ML model. `CPJKU/beat_this` stays an optional later benchmark next to the onset tempo suggestion. Neither is a dependency of playback.

## What this branch reuses

| Web module | Native form |
|---|---|
| `src/lib/frost/types.ts` (`SCHEMA_VERSION` 2) | `Model.swift`. Codable field names match the web JSON, including `session-only` and quantize strings `1/8`, `1/16`, `1/32`. |
| `timing.ts` | `Timing.swift`. Quantize, swing, `eventsInRange`, `playPlan`, gate holds. |
| `wav.ts` | `Wav.swift`. 24-bit encode/decode. |
| `analysis.ts` | `Analysis.swift`. Onsets, tempo suggestion, beat grid, waveform columns. A suggestion is stored on the source and is not written into project BPM until the player asks. |
| `stretch.ts` | `Stretch.swift`. WSOLA, baked before a hit is mixed. |
| `merge.ts`, `persist.ts` (`cleanName`, `migrateProject`) | `Merge.swift`, `Persist.swift`. Phone wins only on a shared edit. View state stays the phone's. Schema 1 gains `beatGrids`. |
| `ops.ts` (project, markers, chops, pad, hits, lanes, export) | `Ops.swift`. Same validation ranges. Built-in kits are not ported. |
| `render.ts` + `voice.ts` schedule | `Voice.swift`, `Render.swift`. One mixer for the mix and for each stem. Frame count, 24-bit, 44.1 or 48 kHz, aligned at 00:00:00. |
| `services.ts` | `PadPlaying`. The SwiftUI screen does not touch `AVAudioEngine` except through that type. |
| `cloud.ts` / `api.server.ts` | `CloudContract.swift` builds `POST /api/cloud` with `x-frost-key`. It has no send method. |
| Pad grid order in `PadsView.tsx` | Bottom row is pads 1–4. |

The web engine, React UI, IndexedDB, MCP route, and key check are untouched.

## What this branch adds

`ios/FrostSamplerKit` is a Swift package with no Apple-only dependency on the types above. `AVAudioPadEngine` is behind `canImport(AVFoundation)`:

- `AVAudioSession` category `.playback` (silent switch does not mute).
- Preferred IO buffer 5 ms. Not measured on hardware.
- One `AVAudioPlayerNode` per pad, connected before the first tap.
- A tap renders that one hit and retriggers the pad's node (monophonic live). Pattern play renders the mix with the offline mixer and plays that buffer, so the pattern clock is the export clock.
- An interruption stops the engine. The next tap calls `resume()`. Audio does not start again by itself.

`ios/FrostSampler` is a SwiftUI app, bundle id `app.fendifrost.frost-sampler` (not registered), iOS 17, portrait. Import from Files, waveform, sensitivity chop onto the current bank, tempo slider, optional "use suggestion", pattern play, 24-bit mix or stems at 44.1/48 kHz, share sheet. Empty pads stay empty. There is no subscription screen. Cloud is described as not connected.

## Export numbers

The web device check (`selftest.ts`) is the acceptance bar: 24-bit, shared frame count, hit error ≤ 1.5 samples, stems sum to the mix. The package test `testExportTimingAndStemSum` renders the same click pattern (natural, repitch, stretch, swing, quantize off and 1/16) at 44.1 kHz and 48 kHz and checks those limits. It does not claim a measurement on an iPhone speaker.

Pan in the mixer is a linear balance that is unity at center. The web graph uses `StereoPannerNode`. The timing fixture uses pan 0, so this difference is not covered. Match the Web Audio curve before shipping a pan control that has to agree with old exports.

## Test results

Host: Ubuntu 24.04, Swift 6.2.3, `x86_64-unknown-linux-gnu`. Command: `cd ios/FrostSamplerKit && swift test`.

36 tests, 0 failures, about 5.9 seconds of test time. Suites: timing (including the web cases for swing, quantize, song order, and fit-to-length), 24-bit WAV round trip, onsets, swells, clipped 808, tempo suggestion, beat grid, WSOLA length and pitch, project merge, schema migration, WAV import that does not apply detected BPM, auto-chop onto pads, cloud request shape with an empty key refused, software engine refusing a pad with no buffer, and the export timing/stem check above.

Not run, because this machine has no Xcode and no simulator:

- `AVAudioPadEngine` compile and tap latency
- silent switch, phone-call interruption, backgrounding
- Files import of MP3
- share sheet
- the PWA checklist in `DEVICE_PROOF.md`

No production request was sent. The cloud test uses host `example.test` and the fixture string `example-key-not-a-secret`.

## Cost

$0. No GPU rental, no Hugging Face inference, no Lovable chat credit, no database migration, no Apple Developer charge. The $99 yearly developer program is a later distribution cost and was not spent. `FROST_MCP_KEY` was not read.

## Blockers

1. **No iOS toolchain here.** The app project is compiling-ready for Xcode 16. It was not built. `AVAudioEngine` was not type-checked.
2. **PWA device proof is still absent** from `DEVICE_PROOF.md`. Native code does not retire that measurement.
3. **Live engine is monophonic per pad.** Overlapping hits on one pad are correct in the offline mixer (export and pattern play), not in a rapid retrigger of the same `AVAudioPlayerNode`.
4. **No on-device project library yet.** Relaunch does not reopen a project. IndexedDB stays the web working copy.
5. **Cloud client cannot sync.** The request builder is tested. URLSession, Keychain, 409 merge, and signed audio URLs are the next client milestone. Do not add a route that skips `FROST_MCP_KEY`.
6. **Kits are not ported.** `kits.ts` stays the web synthesizer. This app does not ship drum samples.
7. **Signing team is empty.** Bundle id is unregistered.
8. **Issue #78 is open.** Until Agent Hub can ingest an external write-up and show a delivery receipt, assume Grok's Control Center inbox has not seen this plan just because a GitHub PR exists.

## Next milestones

Order is dependency, not a calendar.

1. On a Mac, open the Xcode project, fix any Apple SDK mismatch, run the app on a simulator and then on an iPhone. Record missed taps, silent-switch behavior, interruption, and export time. Keep the 1.5-sample bar.
2. Run `DEVICE_PROOF.md` on the existing Home Screen app and file that report separately. Do not edit the thresholds.
3. Save projects and original bytes on disk. Reopen must decode to the same samples.
4. Keychain for the owner-typed key, then `POST /api/cloud` using `CloudRequestBuilder`, merge on 409 with `mergeProjects`, audio via the signed URLs the server already returns. Serialize pushes per project the way `sync.ts` does.
5. Record taps into the pattern with `recordPosition`, including output-latency calibration, still non-destructive quantize.
6. Port `kits.ts` (synthesized, deterministic, no sample library) if the pads need factory drums.
7. Only after pads work offline: a `beat_this` Core ML benchmark against `suggestTempo` and tapped markers. A miss does not change the pad engine. SAM Audio stays off that path.

## Explicit non-goals

- A `WKWebView` wrapper of the website.
- A second database, a public audio bucket, or a key compiled into the client.
- Hosted generation (ACE-Step, SAM Audio, Wan, or any paid GPU) inside this app.
- Rewriting Dress, lip sync, or any AVT pipeline. That work lives in the other repo and is not approved by this plan.
