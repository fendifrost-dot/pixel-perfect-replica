import { useEffect, useState } from "react";
import { ChevronDown, Circle, Minus, Play, Plus, Square, Timer, Undo2 } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { ProjectsSheet } from "./ProjectsSheet";
import { cn } from "@/lib/utils";

export function TopBar() {
  const { project, commit, playing, togglePlay, recording, setRecording, metronome, setMetronome, undo, canUndo, saveState, loopMode } =
    useFrost();
  const [projectsOpen, setProjectsOpen] = useState(false);
  const setBpm = (v: number) =>
    commit((p) => ({ ...p, bpm: Math.min(300, Math.max(40, Math.round(v * 10) / 10)) }), { history: false });
  // Typed BPM is kept as text while editing and applied on Enter / blur, so "1", "12", "120" can
  // be typed without each keystroke being clamped (typing "1" must not become 40, then "402").
  const [bpmText, setBpmText] = useState<string | null>(null);
  useEffect(() => setBpmText(null), [project.bpm]);
  const applyBpm = () => {
    if (bpmText == null) return;
    const v = Number(bpmText.replace(",", "."));
    setBpmText(null);
    if (bpmText.trim() !== "" && Number.isFinite(v) && v > 0) setBpm(v);
  };

  return (
    <header className="safe-top sticky top-0 z-20 border-b bg-background/95 px-3 pb-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left" onClick={() => setProjectsOpen(true)}>
          <span className="truncate text-base font-bold">{project.isDemo ? "New project" : project.name}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              saveState === "saved" ? "bg-teal" : saveState === "error" ? "bg-rec" : saveState === "saving" ? "bg-primary" : "bg-muted-foreground/40",
            )}
            title={saveState === "new" ? "Not saved yet — import audio to start" : saveState}
          />
        </button>
        <button aria-label="Undo" className="btn size-11 px-0" onClick={undo} disabled={!canUndo}>
          <Undo2 className="size-5" />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button aria-label={playing ? "Stop" : "Play"} onClick={togglePlay} className={cn("btn w-14 px-0", playing ? "btn-on" : "btn-primary")}>
          {playing ? <Square className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
        </button>
        <button
          aria-label="Record notes"
          aria-pressed={recording}
          onClick={() => setRecording(!recording)}
          className={cn("btn w-12 px-0", recording && "bg-rec text-foreground")}
        >
          <Circle className={cn("size-5", recording && "fill-current")} />
        </button>
        <button aria-label="Metronome" aria-pressed={metronome} onClick={() => setMetronome(!metronome)} className={cn("btn w-12 px-0", metronome && "btn-on")}>
          <Timer className="size-5" />
        </button>
        <span className="hidden text-[10px] font-semibold uppercase text-muted-foreground min-[380px]:block">{loopMode === "song" ? "Song" : "Loop"}</span>
        <div className="ml-auto flex items-center gap-1 rounded-md bg-surface p-1">
          <button aria-label="BPM down" className="btn size-9 min-h-9 px-0" onClick={() => setBpm(project.bpm - 1)}>
            <Minus className="size-4" />
          </button>
          <label className="flex flex-col items-center px-1">
            <span className="eyebrow leading-none">BPM</span>
            <input
              type="text"
              inputMode="decimal"
              pattern="[0-9]*[.,]?[0-9]*"
              enterKeyHint="done"
              value={bpmText ?? String(project.bpm)}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setBpmText(e.target.value.replace(/[^\d.,]/g, ""))}
              onBlur={applyBpm}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setBpmText(null);
              }}
              className="w-16 bg-transparent text-center font-mono text-lg font-semibold text-primary outline-none"
            />
          </label>
          <button aria-label="BPM up" className="btn size-9 min-h-9 px-0" onClick={() => setBpm(project.bpm + 1)}>
            <Plus className="size-4" />
          </button>
        </div>
      </div>
      {projectsOpen && <ProjectsSheet onClose={() => setProjectsOpen(false)} />}
    </header>
  );
}
