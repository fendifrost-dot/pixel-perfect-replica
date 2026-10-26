# Handoff — get the Frost 808s and kicks playing in LUNA (Decent Sampler) on Fendi's Mac

**For:** a coding agent (Cursor) running on Fendi's Mac, with a terminal. Fendi watches and does the
clicks inside LUNA. **Status of this doc: nothing below is verified until you run it and report real
output.** Your "done" is not completion — the pasted output is.

## Goal

1. Decent Sampler is installed where LUNA looks for plug-ins, and macOS says it is a valid AU.
2. The two Frost packs are unzipped, intact, in one permanent folder: `~/Music/Frost/`.
3. Every preset points at sound files that exist.
4. Fendi loads one 808 and the kick kit in LUNA and hears them.

## Where things stand

| | State |
|--|--|
| Packs built (Frost Sampler → Export → **Sounds for your DAW**) | CODED + LIVE — PR #23, merge `a331992`, deployed to frost-sampler.lovable.app |
| Both zips sent to Fendi as chat attachments | Done (Fendi has them, most likely in `~/Downloads`) |
| Decent Sampler | Fendi says it's **downloaded** — not confirmed **installed** |
| Unzipped on the Mac / LUNA sees the plug-in / sounds play | **NOT DONE** — this handoff |

Nothing needs to change in the code or in Lovable.

## Expected files (exact values — check them)

| Zip | Size (bytes) | SHA-256 | Entries | `.wav` | `.dspreset` | Top folder |
|--|--|--|--|--|--|--|
| `Frost_Metro-style_808s.zip` | 8,781,185 | `86bb6d535d0ab22cb0cdb4d2a6401fb9e560eb46b1463f963f02d268bfefb53c` | 61 | 30 | 30 | `Frost Metro-style 808s/` |
| `Frost_Dre-style_kicks.zip` | 1,680,893 | `864070c3f402d6acf5790a789d4242fe8f3cbbf4cf061d2d3c59cdc066819531` | 22 | 20 | 1 | `Frost Dre-style kicks/` |

Each top folder holds `Samples/` (the WAVs), the `.dspreset` file(s) and `README.txt`. If Fendi
re-exported a zip from the app instead of the chat attachment, the hash may differ — then the
counts above are what matters; report the hash you got.

## Hard rules

- **Don't edit any `.dspreset` or rename/move anything inside a pack folder** to "make it work".
  The presets find their sounds by the relative path `Samples/<name>.wav`. If a check fails, the
  finding is the mismatch — stop and report it.
- **No iCloud paths.** Nothing under `~/Library/Mobile Documents` or `~/Library/CloudStorage`,
  and not `~/Desktop` / `~/Documents` (those may be iCloud-synced). Use `~/Music/Frost/`.
  Don't use an external drive (e.g. `/Volumes/T7`) for these — if it's unplugged, every LUNA
  session using them loses its sounds. Fendi can choose otherwise; ask first.
- **Don't delete anything.** Don't overwrite an existing `~/Music/Frost/Frost Metro-style 808s` or
  `Frost Dre-style kicks` folder — if one exists, stop and report what's in it.
- Install Decent Sampler only from the official site
  (<https://www.decentsamples.com/product/decent-sampler-plugin/>). No other download sources.
- Never delete `~/Library/Application Support/Claude/vm_bundles`.
- Don't use `sudo` except to run the official Decent Sampler installer if macOS asks for it — and
  Fendi types the password, not you.
- Don't touch Supabase, Lovable, or the repo. This is Mac-only work.

## Steps

### 1. Is Decent Sampler actually installed?

```sh
uname -m
ls -d /Library/Audio/Plug-Ins/Components/Decent* ~/Library/Audio/Plug-Ins/Components/Decent* \
      /Library/Audio/Plug-Ins/VST3/Decent*       ~/Library/Audio/Plug-Ins/VST3/Decent* 2>/dev/null
```

- Expected: at least one `DecentSampler.component` (the **AU** — what LUNA uses on Mac). A
  `.vst3` alongside it is fine.
- Not expected: no `.component` → it's only downloaded. Find the installer
  (`ls ~/Downloads | grep -i decent`), and have **Fendi** open it (a `.pkg` or a `.dmg` containing
  one) and click through, keeping the **AU / Audio Unit** option ticked. Then re-run the `ls`.

Check the plug-in matches the Mac's chip (LUNA on Apple Silicon needs `arm64`):

```sh
lipo -archs "$(ls -d /Library/Audio/Plug-Ins/Components/DecentSampler.component ~/Library/Audio/Plug-Ins/Components/DecentSampler.component 2>/dev/null | head -1)"/Contents/MacOS/*
```

- Expected: contains `arm64` when `uname -m` printed `arm64` (usually `x86_64 arm64`).

### 2. Does macOS accept it as an Audio Unit?

```sh
auval -a 2>/dev/null | grep -i decent
```

- Expected: one line starting with `aumu` (an instrument), e.g. `aumu XXXX YYYY  -  Decent Samples: DecentSampler`.
  Take the three 4-letter codes from that line and run:

```sh
auval -v aumu XXXX YYYY 2>&1 | tail -3
```

- Expected: `* * PASS` and `AU VALIDATION SUCCEEDED.`
- Not expected: no line from `auval -a`, or `FAILED`. Stop and report the full output. (A fresh
  install sometimes needs a logout/login or `killall -9 AudioComponentRegistrar` before `auval -a`
  lists it — you may try that once, then re-run; report that you did.)

### 3. Find the zips and check them

```sh
ls -l ~/Downloads/Frost_*.zip
shasum -a 256 ~/Downloads/Frost_*.zip
for z in ~/Downloads/Frost_*.zip; do echo "$z"; zipinfo -1 "$z" | wc -l; zipinfo -1 "$z" | grep -c '\.wav$'; zipinfo -1 "$z" | grep -c '\.dspreset$'; done
```

- Expected: the sizes, hashes and counts in the table above. A browser may have renamed a repeat
  download `Frost_Metro-style_808s (1).zip` — that's fine, use it, say which file you used.
- Not expected: a zip missing, smaller, or wrong counts → stop and report. (Fendi can re-download
  from the chat, or from the app: Export → **Sounds for your DAW**.)

### 4. Unzip into `~/Music/Frost/`

```sh
mkdir -p ~/Music/Frost
ls -la ~/Music/Frost          # report it; stop if either "Frost …" pack folder already exists
cd ~/Music/Frost
ditto -x -k ~/Downloads/Frost_Metro-style_808s.zip .
ditto -x -k ~/Downloads/Frost_Dre-style_kicks.zip .
pwd -P                        # must NOT contain "Mobile Documents" or "CloudStorage"
ls ~/Music/Frost
```

- Expected: `~/Music/Frost` lists `Frost Dre-style kicks` and `Frost Metro-style 808s` (plus
  anything that was already there, e.g. `Vivaldi pads` from an earlier handoff — leave it alone).
- Use `ditto`, not Finder double-click: Finder may create `Frost_Metro-style_808s 2/` wrapper folders.

### 5. Every preset points at a file that exists

```sh
cd ~/Music/Frost
for d in "Frost Metro-style 808s" "Frost Dre-style kicks"; do
  echo "== $d: $(ls "$d"/Samples/*.wav | wc -l) wav, $(ls "$d"/*.dspreset | wc -l) presets"
  missing=0
  for p in "$d"/*.dspreset; do
    grep -o 'path="[^"]*"' "$p" | sed 's/^path="//;s/"$//' | while IFS= read -r s; do
      [ -f "$d/$s" ] || echo "MISSING: $p -> $s"
    done
  done
done
afinfo "Frost Metro-style 808s/Samples/808 01 Long Clean.wav" | grep -E 'format|duration'
```

- Expected: `30 wav, 30 presets` and `20 wav, 1 presets`, **no `MISSING:` lines**, and `afinfo`
  shows `1 ch, 48000 Hz` and 24-bit (`'lpcm' (0x0000000C) Signed Integer, 24 bits`).
- Not expected: any `MISSING:` line → stop and report it. Don't edit the preset.

### 6. LUNA (Fendi clicks; you guide and watch)

1. **Quit LUNA completely** (⌘Q) if it's open — it looks for new plug-ins when it starts.
2. Open LUNA and open or create a session.
3. Add an **Instrument track** and open its instrument list. Is **Decent Sampler** there?
   - If not: LUNA's settings → **Plugins** (plug-in manager) → rescan. If it's listed as
     disabled or failed, enable it / rescan just that one, then restart LUNA. Report exactly what
     LUNA shows (a screenshot is best).
4. Load **Decent Sampler** on the track and open its window → **File → Load Sample Library…** →
   `~/Music/Frost/Frost Metro-style 808s/808 01 Long Clean.dspreset`.
   - Expected: the title "808 01 Long Clean" and four knobs (Attack, Release, Tune, Volume).
     Every key plays the 808 at that pitch; only one note sounds at a time; a longer MIDI note rings
     longer.
5. On a second Instrument track, load `~/Music/Frost/Frost Dre-style kicks/Dre-style kicks.dspreset`.
   - Expected: MIDI notes **36 to 55** play Kick 01 … Kick 20 (one kick per key, see that folder's
     `README.txt`). Other keys are silent.
   - Note names differ between DAWs: the README lists note 36 as "C2" (middle C = C4) but its header
     says "C1 in most DAWs". **Go by the MIDI note number**, not the name — LUNA may call note 36
     either C1 or C2. That's a labeling difference, not a fault.
6. Save the LUNA session, quit, reopen it. Expected: both tracks still play (proves the presets are
   found from `~/Music/Frost`).

## Report back

Paste, don't summarize:

1. Output of steps 1–5 (including `uname -m`, the `auval` line and its last 3 lines).
2. Which zip files you used (names; hashes if they differ from the table).
3. From Fendi in LUNA: is Decent Sampler in the instrument list (yes/no + what was needed), did the
   808 play, did notes 36–55 play the 20 kicks, did they survive save/reopen. Screenshot of any error.
4. Anything you did that isn't in this doc (e.g. `killall AudioComponentRegistrar`, a rescan).

If everything passes, nothing else remains. If the kicks' note names in LUNA confuse Fendi, report
how LUNA labels note 36 — the README wording in `src/lib/frost/samplerPack.ts` can be fixed in a
follow-up.
