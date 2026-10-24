# Frost Sampler for iOS

Native shell for the pocket sampler. The web app at `frost-sampler.lovable.app` stays the shipping instrument and the only Cloud/MCP host. This tree does not replace it.

## What is here

- `IMPLEMENTATION_PLAN.md` — direction taken from the Sampler sections of [ai-video-tool#379](https://github.com/fendifrost-dot/ai-video-tool/pull/379), plus what this branch actually builds.
- `FrostSamplerKit/` — Swift package. Project JSON (`SCHEMA_VERSION` 2), timing, onset chop, tempo suggestion, WSOLA, 24-bit WAV, offline mix and stems, pad-trigger contract, cloud request builder. No network calls.
- `FrostSampler/` — SwiftUI app (Xcode 16 or newer) that links that package. Import, waveform, chop, 16 pads, tempo, 24-bit export. `AVAudioEngine` is compiled only on Apple platforms.

## Tests on Linux

Swift 6.2 or newer. From this directory's package:

```bash
cd ios/FrostSamplerKit
swift test
```

That run does not boot a simulator and does not open `AVAudioEngine`. It is the check this branch can actually execute here.

## App on a Mac

1. Open `ios/FrostSampler/FrostSampler.xcodeproj` in Xcode 16 or newer.
2. The app target links the local package `../FrostSamplerKit`. Signing team is blank on purpose. Pick your own team to run on a phone. The simulator can use "Sign to Run Locally".
3. Bundle id `app.fendifrost.frost-sampler` is a proposal. It is not registered.
4. Run the Frost Sampler scheme on an iPhone simulator or a device. Import a WAV from Files (MP3 decodes only on device, through `AVAudioFile`). Chop, tap a pad, play the pattern, render WAV, and share the files.
5. Deployment target is iOS 17.

`AVAudioSession` category `.playback` is set so the silent switch does not mute the app. A phone-call interruption stops audio until the next tap. Background audio is not declared.

## Out of scope

No subscriptions, no paywall, no hosted model, no `sam-audio`, no ACE-Step, no second database, no key in the binary. Cloud sync is described in the plan and is not wired to production.
