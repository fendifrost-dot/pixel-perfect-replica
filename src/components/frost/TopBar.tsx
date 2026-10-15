import { Circle, Minus, Play, Plus, Square, Timer, Undo2 } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { cn } from "@/lib/utils";

export function TopBar() {
  const { project, commit, playing, togglePlay, recording, setRecording, metronome, setMetronome, undo, canUndo } =
    useFrost();
  const setBpm = (v: number) =>
    commit((p) => ({ ...p, bpm: Math.min(300, Math.max(40, Math.round(v * 10) / 10)) }), { history: false });

  return (
    <header className="safe-top sticky top-0 z-20 border-b bg-background/95 px-3 pb-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <input
          aria-label="Project name"
          value={project.name}
          onChange={(e) => commit((p) => ({ ...p, name: e.target.value }), { history: false })}
          className="min-w-0 flex-1 truncate bg-transparent text-base font-bold outline-none"
        />
        <button aria-label="Undo" className="btn size-11 px-0" onClick={undo} disabled={!canUndo}>
          <Undo2 className="size-5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
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
        <button
          aria-label="Metronome"
          aria-pressed={metronome}
          onClick={() => setMetronome(!metronome)}
          className={cn("btn w-12 px-0", metronome && "btn-on")}
        >
          <Timer className="size-5" />
        </button>
        <div className="ml-auto flex items-center gap-1 rounded-md bg-surface p-1">
          <button aria-label="BPM down" className="btn size-9 min-h-9 px-0" onClick={() => setBpm(project.bpm - 1)}>
            <Minus className="size-4" />
          </button>
          <label className="flex flex-col items-center px-1">
            <span className="eyebrow leading-none">Project BPM</span>
            <input
              type="number"
              inputMode="decimal"
              value={project.bpm}
              onChange={(e) => setBpm(Number(e.target.value) || 40)}
              className="w-16 bg-transparent text-center font-mono text-lg font-semibold text-primary outline-none"
            />
          </label>
          <button aria-label="BPM up" className="btn size-9 min-h-9 px-0" onClick={() => setBpm(project.bpm + 1)}>
            <Plus className="size-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
