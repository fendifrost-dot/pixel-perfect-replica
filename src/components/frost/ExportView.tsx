import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, FilePlus2, FolderOpen, Share2, Trash2, Upload, XCircle } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { persistenceService } from "@/lib/frost/engine";
import { library } from "@/lib/frost/persist";
import { renderService } from "@/lib/frost/render";
import { runDeviceCheck, type CheckResult } from "@/lib/frost/selftest";
import { songSections, patternSections, sectionsLength } from "@/lib/frost/timing";
import type { RenderedFile } from "@/lib/frost/services";
import type { ExportSettings } from "@/lib/frost/types";
import { cn } from "@/lib/utils";

const dbfs = (x: number) => (x <= 0 ? "−∞" : (20 * Math.log10(x)).toFixed(1)) + " dBFS";

export function ExportView() {
  const { project, commit, replace, notify, projectKey, saveState, openProject, newProject } = useFrost();
  const fileRef = useRef<HTMLInputElement>(null);
  const ex = project.export;
  const set = (patch: Partial<ExportSettings>) => commit((p) => ({ ...p, export: { ...p.export, ...patch } }));
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<RenderedFile[]>([]);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [projects, setProjects] = useState<{ key: string; name: string; savedAt: number }[]>([]);

  const refreshList = () => library.list().then(setProjects).catch(() => setProjects([]));
  useEffect(() => {
    void refreshList();
  }, [projectKey, saveState]);

  const sections = ex.range === "song" ? songSections(project) : patternSections(project, Math.max(1, ex.patternRepeats));
  const steps = sectionsLength(sections);
  const seconds = (steps * 60) / project.bpm / 4;
  const tracks = new Set(sections.flatMap((s) => s.pattern.notes.map((n) => n.padId))).size;

  const render = async () => {
    setBusy("Preparing…");
    setFiles([]);
    try {
      const out = await renderService.renderWav(project, setBusy);
      setFiles(out);
      const clipped = out.filter((f) => f.clipped > 0);
      notify(clipped.length ? `Rendered — ${clipped.length} file(s) clipped. Lower pad volumes and render again.` : `Rendered ${out.length} file(s).`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const asFiles = () => files.map((f) => new File([f.blob], f.name, { type: "audio/wav" }));
  const canShare = typeof navigator !== "undefined" && !!navigator.canShare && files.length > 0 && navigator.canShare({ files: asFiles() });
  const share = async () => {
    try {
      await navigator.share({ files: asFiles(), title: project.name });
    } catch (e) {
      if ((e as Error).name !== "AbortError") notify(`Share failed: ${(e as Error).message}. Use the download links instead.`);
    }
  };
  const download = (f: RenderedFile) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const runChecks = async () => {
    setBusy("Running device check…");
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
      `Standalone (Home Screen): ${window.matchMedia?.("(display-mode: standalone)").matches ? "yes" : "no"}`,
      ...(checks ?? []).map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`),
    ].join("\n");

  return (
    <div className="space-y-3">
      <section className="panel space-y-3">
        <div className="eyebrow">Audio export · WAV 24-bit</div>
        <div className="grid grid-cols-2 gap-2">
          {(["stems", "stereo"] as const).map((m) => (
            <button key={m} className={cn("btn", ex.mode === m && "btn-on")} onClick={() => set({ mode: m })}>
              {m === "stereo" ? "Stereo mix only" : "Mix + separate tracks"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {([44100, 48000] as const).map((r) => (
            <button key={r} className={cn("btn", ex.sampleRate === r && "btn-on")} onClick={() => set({ sampleRate: r })}>{r / 1000} kHz</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["pattern", "song"] as const).map((r) => (
            <button key={r} className={cn("btn", ex.range === r && "btn-on")} onClick={() => set({ range: r })}>
              {r === "song" ? "Song (arrangement)" : "Current pattern"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className={cn(ex.range !== "pattern" && "opacity-50")}>
            <div className="eyebrow mb-1">Pattern repeats</div>
            <input className="field font-mono" type="number" inputMode="numeric" min={1} max={64} value={ex.patternRepeats} disabled={ex.range !== "pattern"}
              onChange={(e) => set({ patternRepeats: Math.max(1, Math.min(64, Math.round(Number(e.target.value)) || 1)) })} />
          </label>
          <label>
            <div className="eyebrow mb-1">Release tail (s)</div>
            <input className="field font-mono" type="number" inputMode="decimal" min={0} max={10} step={0.5} value={ex.tailSec}
              onChange={(e) => { const v = Math.max(0, Math.min(10, Number(e.target.value) || 0)); set({ tailSec: v, includeTails: v > 0 }); }} />
          </label>
        </div>
        <div className="space-y-1 rounded-md bg-background p-3 font-mono text-xs">
          <Row k="Length" v={`${steps / 16} bars · ${seconds.toFixed(3)} s + ${ex.includeTails ? ex.tailSec : 0} s tail`} />
          <Row k="Files" v={ex.mode === "stereo" ? "1 stereo mix" : `1 mix + ${tracks} tracks`} />
          <Row k="Alignment" v="all start at 0:00 (bar 1), identical length" />
        </div>
        <button className="btn btn-primary h-12 w-full" onClick={render} disabled={!!busy || project.isDemo}>
          {busy ?? (project.isDemo ? "Import audio to export" : "Render WAV files")}
        </button>
        {files.length > 0 && (
          <div className="space-y-2">
            {canShare && (
              <button className="btn btn-primary w-full" onClick={share}><Share2 className="size-4" /> Share / Save to Files / AirDrop ({files.length})</button>
            )}
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{f.name}</div>
                    <div className={cn("font-mono text-[10px]", f.clipped ? "text-rec" : "text-muted-foreground")}>
                      peak {dbfs(f.peak)}{f.clipped ? ` · ${f.clipped} clipped samples` : ""} · {(f.blob.size / 1e6).toFixed(1)} MB
                    </div>
                  </div>
                  <button aria-label={`Download ${f.name}`} className="btn min-h-9 w-10 px-0" onClick={() => download(f)}><Download className="size-4" /></button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              In LUNA or Pro Tools: set the session to {project.bpm} BPM and {ex.sampleRate / 1000} kHz, import all files and place each at the session start (bar 1). They line up sample-for-sample.
            </p>
          </div>
        )}
      </section>

      <section className="panel space-y-2">
        <div className="flex items-center justify-between">
          <div className="eyebrow">Projects on this device</div>
          <span className={cn("text-[11px]", saveState === "error" ? "text-rec" : "text-muted-foreground")}>
            {saveState === "demo" ? "Demo — not saved" : saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save failed"}
          </span>
        </div>
        <ul className="space-y-1">
          {projects.map((p) => (
            <li key={p.key} className={cn("flex items-center gap-2 rounded-md bg-background px-2 py-1.5", p.key === projectKey && "ring-1 ring-primary")}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{p.name}</div>
                <div className="text-[10px] text-muted-foreground">{new Date(p.savedAt).toLocaleString()}</div>
              </div>
              <button aria-label={`Open ${p.name}`} className="btn min-h-9 w-10 px-0" disabled={p.key === projectKey}
                onClick={() => openProject(p.key).catch((e: Error) => notify(e.message))}><FolderOpen className="size-4" /></button>
              <button aria-label={`Delete ${p.name}`} className="btn min-h-9 w-10 px-0" disabled={p.key === projectKey}
                onClick={() => { if (confirm(`Delete “${p.name}” from this device?`)) void library.remove(p.key).then(refreshList); }}><Trash2 className="size-4" /></button>
            </li>
          ))}
          {!projects.length && <li className="text-xs text-muted-foreground">No saved projects yet. Import audio to start one — it saves automatically.</li>}
        </ul>
        <button className="btn w-full" onClick={newProject}><FilePlus2 className="size-4" /> New empty project</button>
      </section>

      <section className="panel space-y-2">
        <div className="eyebrow">Device check (proof)</div>
        <p className="text-[11px] text-muted-foreground">
          Renders a test beat through the real export, reads the WAVs back and measures every hit to the sample; checks your pads start and end cleanly; and saves, reopens and re-decodes this project.
        </p>
        <button className="btn w-full" onClick={runChecks} disabled={!!busy}>{busy ?? "Run device check"}</button>
        {checks && (
          <>
            <ul className="space-y-1">
              {checks.map((c, i) => (
                <li key={i} className="flex gap-2 text-xs">
                  {c.pass ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-teal" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-rec" />}
                  <div><div className="font-semibold">{c.name}</div><div className="font-mono text-[10px] text-muted-foreground">{c.detail}</div></div>
                </li>
              ))}
            </ul>
            <button className="btn w-full text-xs" onClick={() => navigator.clipboard?.writeText(report()).then(() => notify("Report copied — paste it back to Claude."), () => notify("Couldn't copy; screenshot the list instead."))}>
              Copy report
            </button>
          </>
        )}
      </section>

      <section className="panel space-y-2">
        <div className="eyebrow">Settings backup</div>
        <p className="text-[11px] text-muted-foreground">A backup file holds chops, pads, patterns and song — not audio. Audio stays in this device's storage.</p>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            replace(await persistenceService.restoreFromFile(f));
            notify("Project restored. Audio stored on this device reloads automatically.");
          } catch (err) {
            notify(`Restore failed: ${(err as Error).message}`);
          }
        }} />
        <div className="grid grid-cols-2 gap-2">
          <button className="btn" onClick={() => persistenceService.backupToFile(project)}><Download className="size-4" /> Backup file</button>
          <button className="btn" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Restore file</button>
        </div>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{k}</span><span className="truncate text-right">{v}</span></div>
  );
}
