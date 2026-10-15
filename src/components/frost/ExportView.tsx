import { useRef } from "react";
import { Download, RotateCcw, Save, Upload } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { persistenceService, renderService } from "@/lib/frost/engine";
import { createDemoProject } from "@/lib/frost/demo";
import type { ExportSettings } from "@/lib/frost/types";
import { Unavailable } from "./Unavailable";
import { cn } from "@/lib/utils";

export function ExportView() {
  const { project, commit, replace, notify } = useFrost();
  const fileRef = useRef<HTMLInputElement>(null);
  const ex = project.export;
  const set = (patch: Partial<ExportSettings>) => commit((p) => ({ ...p, export: { ...p.export, ...patch } }));
  const render = renderService.availability();
  const sessionOnly = project.sources.filter((s) => s.persistence === "session-only");
  const tracks = new Set(project.patterns.flatMap((p) => p.lanes.map((l) => l.padId))).size;

  return (
    <div className="space-y-3">
      <section className="panel space-y-3">
        <div className="eyebrow">Audio export</div>
        <div className="grid grid-cols-2 gap-2">
          {(["stereo", "stems"] as const).map((m) => (
            <button key={m} className={cn("btn", ex.mode === m && "btn-on")} onClick={() => set({ mode: m })}>
              {m === "stereo" ? "Stereo mix" : "Separate tracks"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div><div className="eyebrow mb-1">Format</div><div className="field flex items-center">WAV 24-bit</div></div>
          {([44100, 48000] as const).map((r) => (
            <button key={r} className={cn("btn mt-auto", ex.sampleRate === r && "btn-on")} onClick={() => set({ sampleRate: r })}>{r / 1000} kHz</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(["song", "pattern"] as const).map((r) => (
            <button key={r} className={cn("btn", ex.range === r && "btn-on")} onClick={() => set({ range: r })}>
              {r === "song" ? "Whole song" : "Current pattern"}
            </button>
          ))}
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">Effect / release tail</span>
          <input className="field w-24" type="number" min={0} max={10} step={0.5} value={ex.tailSec} onChange={(e) => set({ tailSec: Number(e.target.value), includeTails: Number(e.target.value) > 0 })} />
        </label>
        <p className="text-[11px] text-muted-foreground">
          All files start at bar 1 · 0:00 and share one length, keeping leading silence so tracks line up in LUNA or Pro Tools.
        </p>
      </section>

      <section className="panel space-y-1 font-mono text-xs">
        <div className="eyebrow mb-1 font-sans">Summary</div>
        <Row k="Project" v={project.name} />
        <Row k="BPM" v={String(project.bpm)} />
        <Row k="Output" v={ex.mode === "stereo" ? "1 stereo file" : `${tracks} track files`} />
        <Row k="Format" v={`WAV ${ex.bitDepth}-bit / ${ex.sampleRate} Hz`} />
        <Row k="Range" v={`${ex.range === "song" ? "Song" : "Pattern"} + ${ex.tailSec}s tail`} />
      </section>

      <Unavailable label="Render WAV" reason={render.available ? "" : render.reason} />

      <section className="panel space-y-2">
        <div className="eyebrow">Project backup</div>
        <p className="text-[11px] text-muted-foreground">
          Backups contain settings, chops, pads, patterns and song — not audio.
          {sessionOnly.length > 0 && ` ${sessionOnly.length} imported recording(s) will need to be re-imported after restore.`}
        </p>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            replace(await persistenceService.restoreFromFile(f));
            notify("Project restored. Re-import audio for any session-only recordings.");
          } catch (err) {
            notify(`Restore failed: ${(err as Error).message}`);
          }
        }} />
        <div className="grid grid-cols-2 gap-2">
          <button className="btn" onClick={() => persistenceService.backupToFile(project)}><Download className="size-4" /> Backup file</button>
          <button className="btn" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Restore file</button>
          <button className="btn" onClick={() => { persistenceService.saveLocal(project); notify("Project settings saved on this device (audio not included)."); }}><Save className="size-4" /> Save on device</button>
          <button className="btn" onClick={() => { const p = persistenceService.loadLocal(); if (p) { replace(p); notify("Loaded saved project."); } else notify("No saved project on this device."); }}><RotateCcw className="size-4" /> Load saved</button>
        </div>
        <button className="btn w-full text-xs text-muted-foreground" onClick={() => replace(createDemoProject())}>Reset to demo project</button>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{k}</span><span className="truncate">{v}</span></div>
  );
}
