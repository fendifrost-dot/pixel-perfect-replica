import { useState } from "react";
import { CheckCircle2, ChevronDown, Download, Share2, XCircle } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { recordOffset } from "@/lib/frost/device";
import { renderService } from "@/lib/frost/render";
import { runDeviceCheck, type CheckResult } from "@/lib/frost/selftest";
import { songSections, patternSections, sectionsLength } from "@/lib/frost/timing";
import type { RenderedFile } from "@/lib/frost/services";
import type { ExportSettings } from "@/lib/frost/types";
import { Segmented } from "./controls";
import { cn } from "@/lib/utils";

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

  // Pad samples: every pad's sound as its own WAV, no beat needed.
  const [padMode, setPadMode] = useState<"pad" | "original">("pad");
  const [padFiles, setPadFiles] = useState<RenderedFile[]>([]);
  const padCount = project.pads.filter((x) => x.sliceId).length;
  const renderPads = async () => {
    setBusy("Preparing…");
    setPadFiles([]);
    try {
      const { files: out, skipped } = await renderService.renderPadSamples(project, padMode, setBusy);
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
        <button className="btn btn-primary h-12 w-full" onClick={renderPads} disabled={!!busy || !padCount}>
          {busy ?? (padCount ? `Export ${padCount} pad sample${padCount === 1 ? "" : "s"}` : "No pads have a sound yet")}
        </button>
        {padFiles.length > 0 && <FileList files={padFiles} title={`${project.name} pads`} />}
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

/** Rendered WAVs: save them all at once (Files / AirDrop) or download one by one. */
function FileList({ files, title }: { files: RenderedFile[]; title: string }) {
  const { notify } = useFrost();
  const asFiles = () => files.map((f) => new File([f.blob], f.name, { type: "audio/wav" }));
  const canShare =
    typeof navigator !== "undefined" && !!navigator.canShare && files.length > 0 && navigator.canShare({ files: asFiles() });
  const share = async () => {
    try {
      await navigator.share({ files: asFiles(), title });
    } catch (e) {
      if ((e as Error).name !== "AbortError") notify(`Share failed: ${(e as Error).message}. Use the download buttons instead.`);
    }
  };
  const download = (f: RenderedFile) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div className="space-y-2">
      {canShare && (
        <button className="btn btn-primary w-full" onClick={share}>
          <Share2 className="size-4" /> Save to Files / AirDrop ({files.length})
        </button>
      )}
      <ul className="space-y-1">
        {files.map((f) => (
          <li key={f.name} className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold">{f.name}</div>
              <div className={cn("font-mono text-[10px]", f.clipped ? "text-rec" : "text-muted-foreground")}>
                peak {dbfs(f.peak)}
                {f.clipped ? " · too loud (clipped)" : ""} · {(f.blob.size / 1e6).toFixed(1)} MB
              </div>
            </div>
            <button aria-label={`Download ${f.name}`} className="btn min-h-9 w-10 px-0" onClick={() => download(f)}>
              <Download className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
