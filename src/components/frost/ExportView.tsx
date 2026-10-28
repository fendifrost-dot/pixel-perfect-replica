import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, Download, Share2, XCircle } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { recordOffset } from "@/lib/frost/device";
import { renderService } from "@/lib/frost/render";
import { runDeviceCheck, type CheckResult } from "@/lib/frost/selftest";
import { songSections, patternSections, sectionsLength } from "@/lib/frost/timing";
import type { RenderedFile } from "@/lib/frost/services";
import { BANKS, type ExportSettings } from "@/lib/frost/types";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";
import { FileList } from "./FileList";
import { KITS } from "@/lib/frost/kits";
import { buildSamplerPack, isPitchedKit } from "@/lib/frost/samplerPack";

const dbfs = (x: number) => (x <= 0 ? "−∞" : (20 * Math.log10(x)).toFixed(1)) + " dB";

export function ExportView() {
  const { project, commit, notify, projectKey } = useFrost();
  const ex = project.export;
  const set = (patch: Partial<ExportSettings>) =>
    commit((p) => ({ ...p, export: { ...p.export, ...patch } }));
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<RenderedFile[]>([]);
  const [checkOpen, setCheckOpen] = useState(false);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [offset, setOffset] = useState(recordOffset.get);
  // Edited as text, applied on Enter / blur, so "-" and a cleared box don't snap to 0 mid-typing.
  const [offsetText, setOffsetText] = useState<string | null>(null);
  const applyOffset = () => {
    if (offsetText == null) return;
    const n = Number(offsetText);
    setOffsetText(null);
    if (offsetText.trim() === "" || !Number.isFinite(n)) return;
    const v = Math.max(-200, Math.min(200, Math.round(n)));
    setOffset(v);
    recordOffset.set(v);
  };

  const sections =
    ex.range === "song"
      ? songSections(project)
      : patternSections(project, Math.max(1, ex.patternRepeats));
  const steps = sectionsLength(sections);
  const seconds = (steps * 60) / project.bpm / 4;
  const tracks = new Set(sections.flatMap((s) => s.pattern.notes.map((n) => n.padId))).size;
  const noSong = ex.range === "song" && !project.arrangement.length;

  const render = async () => {
    setBusy("Preparing…");
    setFiles([]);
    try {
      const out = await renderService.renderWav(project, setBusy);
      setFiles(out);
      const clipped = out.filter((f) => f.clipped > 0);
      notify(
        clipped.length
          ? `Done — ${clipped.length} file(s) are too loud and clipped. Lower pad volumes and render again.`
          : `Done — ${out.length} file(s) ready.`,
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Kits as sampler instruments for the DAW (.zip of WAVs + Decent Sampler presets).
  const [packId, setPackId] = useState("metro808");
  const [packFiles, setPackFiles] = useState<RenderedFile[]>([]);
  const packKit = KITS.find((k) => k.id === packId);
  const exportPack = () => {
    if (!packKit) return;
    setBusy("Rendering sounds…");
    setPackFiles([]);
    // let the button show its state before the (blocking) render
    setTimeout(() => {
      try {
        const { fileName, bytes } = buildSamplerPack(packKit, ex.sampleRate);
        setPackFiles([
          {
            name: fileName,
            blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
            frames: 0,
            peak: 0,
            clipped: 0,
            kind: "stem",
          },
        ]);
        notify(`${packKit.name} ready — save it to your Mac and unzip.`);
      } catch (e) {
        notify((e as Error).message);
      } finally {
        setBusy(null);
      }
    }, 30);
  };

  // Pad samples: every pad's sound as its own WAV, no beat needed.
  const [padMode, setPadMode] = useState<"pad" | "original">("pad");
  const [padFiles, setPadFiles] = useState<RenderedFile[]>([]);
  // Pads with a sound, grouped by bank in pad order (A1..A16, B1..), for the pick list.
  const padGroups = useMemo(
    () =>
      BANKS.map((bank) => ({
        bank,
        pads: project.pads
          .filter((x) => x.bank === bank && x.sliceId)
          .sort((a, b) => a.index - b.index)
          .map((x) => ({
            id: x.id,
            name: project.slices.find((s) => s.id === x.sliceId)?.name ?? "Chop",
          })),
      })).filter((g) => g.pads.length),
    [project.pads, project.slices],
  );
  const soundPadIds = useMemo(() => padGroups.flatMap((g) => g.pads.map((x) => x.id)), [padGroups]);
  // Which pads to export: component state only, starts as all; pads that lose their sound drop out.
  const [chosenPads, setChosenPads] = useState<Set<string>>(() => new Set(soundPadIds));
  const [padsTouched, setPadsTouched] = useState(false);
  useEffect(() => {
    setChosenPads((prev) => {
      const next = new Set(soundPadIds.filter((id) => (padsTouched ? prev.has(id) : true)));
      // keep newly-added pads selected until the user has made a choice
      if (!padsTouched) return next;
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
  }, [soundPadIds, padsTouched]);
  const togglePad = (id: string) => {
    setPadsTouched(true);
    setChosenPads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const choosePads = (ids: string[]) => {
    setPadsTouched(true);
    setChosenPads(new Set(ids));
  };
  const padCount = soundPadIds.length;
  const chosenCount = chosenPads.size;
  const renderPads = async () => {
    setBusy("Preparing…");
    setPadFiles([]);
    try {
      const { files: out, skipped } = await renderService.renderPadSamples(
        project,
        padMode,
        setBusy,
        [...chosenPads],
      );
      setPadFiles(out);
      notify(
        skipped.length
          ? `${out.length} sample(s) ready. Skipped ${skipped.join(", ")} — their recording isn't loaded on this phone.`
          : `${out.length} sample(s) ready.`,
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runChecks = async () => {
    setBusy("Checking…");
    setChecks(null);
    try {
      setChecks(await runDeviceCheck(project, projectKey, setBusy));
    } finally {
      setBusy(null);
    }
  };
  const report = () =>
    [
      `Frost Sampler device check — ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
      `Home Screen app: ${window.matchMedia?.("(display-mode: standalone)").matches ? "yes" : "no"}`,
      `Record offset: ${offset} ms`,
      ...(checks ?? []).map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`),
    ].join("\n");

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <section className="panel space-y-3">
        <div className="export-summary">
          <div>
            <strong>WAV</strong>
            <span>UNCOMPRESSED AUDIO</span>
          </div>
          <div>
            <strong>
              24<span className="!inline !text-xs"> bit</span>
            </strong>
            <span>BIT DEPTH</span>
          </div>
          <div>
            <strong>
              {ex.sampleRate / 1000}
              <span className="!inline !text-xs"> kHz</span>
            </strong>
            <span>SAMPLE RATE</span>
          </div>
        </div>
        <div className="eyebrow">Export range</div>
        <Segmented
          value={ex.range}
          onChange={(r) => set({ range: r })}
          options={[
            { value: "pattern", label: "Pattern" },
            { value: "song", label: "Song" },
          ]}
        />
        {ex.range === "pattern" && (
          <label className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 text-muted-foreground">Repeat ×{ex.patternRepeats}</span>
            <input
              type="range"
              className="h-8 min-w-0 flex-1"
              min={1}
              max={16}
              value={ex.patternRepeats}
              onChange={(e) => set({ patternRepeats: Number(e.target.value) })}
            />
          </label>
        )}
        <Segmented
          value={ex.mode}
          onChange={(m) => set({ mode: m })}
          options={[
            { value: "stems", label: "Mix + each pad" },
            { value: "stereo", label: "Mix only" },
          ]}
        />
        <Segmented
          value={ex.sampleRate}
          onChange={(r) => set({ sampleRate: r })}
          options={[
            { value: 48000, label: "48 kHz" },
            { value: 44100, label: "44.1 kHz" },
          ]}
        />
        <p className="text-[11px] text-muted-foreground">
          {noSong
            ? "The song is empty — add patterns on Beat → Song, or export the pattern."
            : `${steps / 16} bars · ${seconds.toFixed(1)} s + ${ex.tailSec} s fade-out room · ${ex.mode === "stereo" ? "1 file" : `${1 + tracks} files`}, all starting at bar 1.`}
        </p>
        <button
          className="btn btn-primary h-12 w-full"
          onClick={render}
          disabled={!!busy || project.isDemo || noSong}
        >
          {busy ?? (project.isDemo ? "Import audio first" : "Render")}
        </button>
        {files.length > 0 && (
          <div className="space-y-2">
            <FileList files={files} title={project.name} />
            <p className="text-[11px] text-muted-foreground">
              In LUNA or Pro Tools: set the session to {project.bpm} BPM and {ex.sampleRate / 1000}{" "}
              kHz, then drop every file at bar 1. They line up exactly.
            </p>
          </div>
        )}
      </section>

      <section className="panel space-y-3" aria-label="Pad samples">
        <div className="eyebrow">Pad samples</div>
        <p className="text-[11px] text-muted-foreground">
          Every pad with a sound as its own WAV — no beat or timeline needed. Load them into your
          DAW's sampler or drop them on a track and keep working on the computer.
        </p>
        <Segmented
          value={padMode}
          onChange={setPadMode}
          options={[
            { value: "pad", label: "As they play on the pads" },
            { value: "original", label: "Original cuts" },
          ]}
        />
        <p className="text-[11px] text-muted-foreground">
          {padMode === "pad"
            ? `With each pad's stretch / fit to ${project.bpm} BPM, pitch, reverse and fades — at full level and centred, so you mix them in the DAW.`
            : "Exactly what you cut from the recording, nothing changed (only a 2 ms fade at each edge so it doesn't click)."}{" "}
          {padCount} pad{padCount === 1 ? "" : "s"} · 24-bit · {ex.sampleRate / 1000} kHz.
        </p>
        {padCount > 0 && (
          <div className="space-y-2" aria-label="Pads to export">
            <div className="flex items-center justify-between">
              <div className="eyebrow">
                Pads to export · {chosenCount} of {padCount}
              </div>
              <div className="flex gap-1">
                <button
                  className="btn min-h-8 px-2.5 text-xs"
                  onClick={() => choosePads(soundPadIds)}
                  disabled={chosenCount === padCount}
                >
                  All
                </button>
                <button
                  className="btn min-h-8 px-2.5 text-xs"
                  onClick={() => choosePads([])}
                  disabled={chosenCount === 0}
                >
                  None
                </button>
              </div>
            </div>
            {padGroups.map((g) => (
              <div key={g.bank} className="space-y-1">
                {padGroups.length > 1 && (
                  <div className="text-[10px] font-semibold uppercase text-muted-foreground">
                    Bank {g.bank}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                  {g.pads.map((x) => (
                    <button
                      key={x.id}
                      role="checkbox"
                      aria-checked={chosenPads.has(x.id)}
                      aria-label={`${x.id} · ${x.name}`}
                      className={cn(
                        "btn min-h-9 justify-start px-2 text-left text-xs",
                        chosenPads.has(x.id) && "btn-on",
                      )}
                      onClick={() => togglePad(x.id)}
                    >
                      <span className="truncate">
                        <span className="font-mono">{x.id}</span> · {x.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className="btn btn-primary h-12 w-full"
          onClick={renderPads}
          disabled={!!busy || !chosenCount}
        >
          {busy ??
            (padCount
              ? chosenCount
                ? `Export ${chosenCount} pad sample${chosenCount === 1 ? "" : "s"}`
                : "Pick at least one pad"
              : "No pads have a sound yet")}
        </button>
        {padFiles.length > 0 && <FileList files={padFiles} title={`${project.name} pads`} />}
      </section>

      <section className="panel space-y-3" aria-label="Sounds for your DAW">
        <div className="eyebrow">Sounds for your DAW</div>
        <p className="text-[11px] text-muted-foreground">
          Any built-in kit as a playable instrument for LUNA: the WAVs plus presets for the free
          Decent Sampler plug-in, in one .zip.
          {packKit && isPitchedKit(packKit)
            ? " Each sound plays on every key, one note at a time like a real 808 line — edit the notes and their lengths in LUNA's piano roll."
            : " One sound per key from C1 (MIDI 36) up — pick a sound by its note in LUNA's piano roll."}
        </p>
        <select
          className="field w-full text-sm"
          aria-label="Kit to export"
          value={packId}
          onChange={(e) => setPackId(e.target.value)}
        >
          {KITS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name} ({k.drums.length})
            </option>
          ))}
        </select>
        <button
          className="btn btn-primary h-12 w-full"
          disabled={!!busy || !packKit}
          onClick={exportPack}
        >
          {busy ?? `Download ${packKit?.name ?? ""} for LUNA (.zip)`}
        </button>
        {packFiles.length > 0 && <FileList files={packFiles} title={packFiles[0].name} />}
        <p className="text-[11px] text-muted-foreground">
          On your Mac: install Decent Sampler (free), unzip, then in LUNA put Decent Sampler on an
          instrument track and load a .dspreset from the folder. The README inside has the steps.
        </p>
      </section>

      <section className="panel space-y-3">
        <button
          className="flex w-full items-center justify-between"
          onClick={() => setCheckOpen(!checkOpen)}
        >
          <span className="eyebrow">Device check</span>
          <ChevronDown
            className={cn(
              "size-4 text-muted-foreground transition-transform",
              checkOpen && "rotate-180",
            )}
          />
        </button>
        {checkOpen && (
          <>
            <p className="text-[11px] text-muted-foreground">
              Tests this phone: export timing to the sample, tracks adding up to the mix, clean pad
              starts/ends, and saving + reopening this project.
            </p>
            <button className="btn w-full" onClick={runChecks} disabled={!!busy}>
              {busy ?? "Run device check"}
            </button>
            {checks && (
              <>
                <ul className="space-y-1">
                  {checks.map((c, i) => (
                    <li key={i} className="flex gap-2 text-xs">
                      {c.pass ? (
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-teal" />
                      ) : (
                        <XCircle className="mt-0.5 size-4 shrink-0 text-rec" />
                      )}
                      <div>
                        <div className="font-semibold">{c.name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {c.detail}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  className="btn w-full text-xs"
                  onClick={() =>
                    navigator.clipboard?.writeText(report()).then(
                      () => notify("Report copied — paste it to Claude."),
                      () => notify("Couldn't copy; screenshot the list instead."),
                    )
                  }
                >
                  Copy report
                </button>
              </>
            )}
            <label className="flex items-center justify-between gap-2 border-t pt-3 text-xs">
              <span>
                Recording timing fix
                <span className="block text-[10px] text-muted-foreground">
                  If recorded hits land late, raise this (ms).
                </span>
              </span>
              <input
                className="field w-20 font-mono"
                type="text"
                inputMode="numeric"
                pattern="-?[0-9]*"
                enterKeyHint="done"
                value={offsetText ?? String(offset)}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setOffsetText(e.target.value.replace(/[^\d-]/g, ""))}
                onBlur={applyOffset}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setOffsetText(null);
                }}
              />
            </label>
          </>
        )}
      </section>
    </div>
  );
}
