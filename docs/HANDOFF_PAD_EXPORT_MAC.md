# Handoff — download the Vivaldi pad samples on Fendi's Mac

**For:** a Claude agent running on Fendi's Mac with browser control (Claude in Chrome or computer use)
and a terminal. Fendi watches. **Status of this doc: nothing below is verified until you run it and
report real output.**

## Goal

Export every pad of the project **"Vivaldi Gelido in ogni vena (Winter) from Farnace Christopher
Lowrey, countertenor, Voices of Music"** from Frost Sampler as WAV files. Save them on the Mac in
`~/Music/Frost/Vivaldi pads/`, check every file, and report anything that's off.

- App: <https://frost-sampler.lovable.app>. The feature is Export → **Pad samples**, shipped in
  PR #18 (merge `d7875a9`).
- Project cloud key: `prj_mvj21g0beja4`, 132 BPM, **15 pads with sound**.
- The recording (`src_8u863p69`, an MP3) has a cloud copy. On a new device the app downloads it
  automatically once Cloud sync is on.

## Hard rules

- **Never type, read, paste or store the Frost key** (`FROST_MCP_KEY`). When the key field appears,
  stop and say: *"Please type your Frost key into the Cloud sync box and tap Save — tell me when done."*
  Don't screenshot the field after it's filled.
- **Don't edit the project.** No tapping pads, no dragging on the Timeline, no Undo, no rename,
  no delete. Opening the project and exporting changes nothing; anything else might sync back to the phone.
- Don't use the Supabase CLI or dashboard. Don't touch Lovable settings. Don't delete any files
  (move them only).
- If a step's real output doesn't match what's expected here, **stop and report it**. Don't
  work around it.

## Steps

1. **Open the app** in Chrome or Safari on the Mac: `https://frost-sampler.lovable.app`. Fully reload
   it once (⌘⇧R) so it's the latest version.
2. **Turn on Cloud sync:** tap the project name at the top right (it reads "Untitled session" on a new
   browser) → the **Cloud sync** box → **Fendi types the key** and taps **Save**.
   - Expected: the box says it's **on / synced**, and the project list shows the Vivaldi project.
   - Not expected: "wrong key" or an error. Stop and report the exact message.
3. **Open the Vivaldi project** from that list. Close the sheet.
4. **Wait for the recording:** go to **Chop**. Expected: a waveform appears within about a minute
   (it's downloading the MP3).
   - Not expected: a message like *"isn't loaded on this phone yet"*, or no waveform after 2 minutes.
     Stop and report it, with a screenshot.
5. **Check export settings:** go to **Export**. At the top, **48 kHz** should be selected. Don't
   change it unless Fendi asks.
6. **Export "As they play on the pads":**
   - In the **Pad samples** box, choose **As they play on the pads**.
   - The button must read **Export 15 pad samples**. If the number isn't 15, stop and report it.
   - Click it. Expected toast: **"15 sample(s) ready."** If it says *"Skipped …"*, report which pads.
   - A file list appears. On a Mac, use the **download button next to each file** (15 clicks).
     If the browser asks to allow multiple downloads, allow it.
7. **Move them** into a folder (in Terminal):
   ```bash
   mkdir -p ~/Music/Frost/"Vivaldi pads"/"As played"
   mv ~/Downloads/Vivaldi_Gelido_in_ogni_vena_*.wav ~/Music/Frost/"Vivaldi pads"/"As played"/
   ```
8. **Optional, if Fendi wants the raw cuts too:** choose **Original cuts** → **Export 15 pad samples**
   → download all → move them into `~/Music/Frost/"Vivaldi pads"/"Original cuts"/` (their names end
   in `_original.wav`).

## Verify (paste the real output)

```bash
cd ~/Music/Frost/"Vivaldi pads"/"As played"
ls *.wav | wc -l            # expect 15
for f in *.wav; do printf '%s\t' "$f"; afinfo "$f" | awk -F': ' '/estimated duration/{d=$2} /Data format/{fmt=$2} END{print d"\t"fmt}'; done
```

Each file should be **2 channels, 24-bit, 48000 Hz**. Durations must match within ±0.005 s. Match on
the **pad id** in the file name (`_A13_`, `_C1_` …):

| Pad | Chop | As played (s) | Original cut (s) | File name contains |
|---|---|---|---|---|
| A8 | Chop 13 | **1.364** (3 beats @132) | 1.406 | `_A8_Chop_13_3beats_132bpm` |
| A9 | Chop 17 | **3.750** (8.25 beats) | 3.774 | `_A9_Chop_17_8.25beats_132bpm` |
| A13 | Chop 12 | **3.778** (8.312 beats, +1 st) | 3.749 | `_A13_Chop_12_8.312beats_132bpm` |
| A14 | Chop 14 | **4.773** (10.5 beats) | 2.404 | `_A14_Chop_14_10.5beats_132bpm` |
| A15 | Chop 15 | 7.822 | 7.822 | `_A15_Chop_15` |
| A16 | Chop 16 | 5.839 | 5.839 | `_A16_Chop_16` |
| B1 | Sketch – Opera call | 0.909 | 0.909 | `_B1_` |
| B2 | Sketch – Opera reply | 0.455 | 0.455 | `_B2_` |
| B3 | Sketch – Opera flick | 0.227 | 0.227 | `_B3_` |
| B4 | Sketch – Reverse breath | 0.455 (**plays reversed**) | 0.455 (forward) | `_B4_` |
| C1 | Westside kick | 0.450 | 0.450 | `_C1_` |
| C2 | Westside snare | 0.420 | 0.420 | `_C2_` |
| C3 | 808 clap | 0.450 | 0.450 | `_C3_` |
| C4 | 808 closed hat | 0.120 | 0.120 | `_C4_` |
| C5 | Westside rim | 0.200 | 0.200 | `_C5_` |

Also check:
- The Export list shows no file marked **"too loud (clipped)"**. If any is, note which.
- Listen to **B4** (`afplay` the file). It should play backwards in "As played", and forwards in "Original cuts".
- Listen to one fitted pad, e.g. A13. It should sound like the chop, slightly stretched, with no
  clicks at the start or end.

## Report back to Fendi

- How many files were downloaded, and where they are.
- The verify output (paste it).
- Any row that doesn't match the table: pad, expected value, actual value.
- Any message the app showed that isn't listed above, quoted exactly.
- If a step failed, which step it was and what you saw. Don't retry a different way without saying so.

Possible issues and what they mean (diagnose, don't fix):
- The waveform never loads → the cloud copy of the recording couldn't be fetched (check the browser
  console for errors from `/api/cloud`).
- Fewer than 15 pads → the project on the Mac isn't the latest. Compare with the phone, which should
  have synced at 2026-10-25 19:30 UTC or later.
- Durations off by a lot on A8/A9/A13/A14 only → stretch/fit issue. Durations off on every file → the
  sample rate isn't 48 kHz.
