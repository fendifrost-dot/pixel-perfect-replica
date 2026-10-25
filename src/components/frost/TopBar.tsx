import { useEffect, useState } from "react";
import { ChevronDown, Circle, Minus, Play, Plus, Repeat, Square, Timer, Undo2 } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { ProjectsSheet } from "./ProjectsSheet";
import { cn } from "@/lib/utils";

export function TopBar() {
  const {
    project,
    commit,
    playing,
    togglePlay,
    recording,
    setRecording,
    metronome,
    setMetronome,
    repeat,
    setRepeat,
    undo,
    canUndo,
    saveState,
    loopMode,
    currentStep,
  } = useFrost();
  const [projectsOpen, setProjectsOpen] = useState(false);
  const setBpm = (v: number) =>
    commit((p) => ({ ...p, bpm: Math.min(300, Math.max(40, Math.round(v * 100) / 100)) }), {
      history: false,
    });
  // Keep partial input editable; commit a validated tempo only on Enter / blur.
  const [bpmText, setBpmText] = useState<string | null>(null);
  useEffect(() => setBpmText(null), [project.bpm]);
  const applyBpm = () => {
    if (bpmText == null) return;
    const v = Number(bpmText.replace(",", "."));
    setBpmText(null);
    if (bpmText.trim() !== "" && Number.isFinite(v) && v > 0) setBpm(v);
  };
  const saveLabel = {
    new: "New session",
    saved: "Saved on device",
    saving: "Saving…",
    error: "Save failed",
  }[saveState];
  return (
    <header className="studio-header safe-top">
      <div className="identity-row">
        <div className="frost-brand" aria-label="Frost Sampler">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="brand-word">
            FROST<span>SAMPLER</span>
          </span>
        </div>
        <span className="brand-edition">THE POCKET STUDIO</span>
        <button
          className="project-switcher"
          onClick={() => setProjectsOpen(true)}
          aria-label={`Open projects: ${project.isDemo ? "New project" : project.name}`}
        >
          <span className="project-copy">
            <strong>{project.isDemo ? "Untitled session" : project.name}</strong>
            <span className="save-label">
              <i className={cn("save-dot", `save-${saveState}`)} />
              {saveLabel}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </button>
      </div>
      <div className="transport-row" aria-label="Transport">
        <div className="transport-actions">
          <button
            aria-label={playing ? "Stop" : "Play"}
            onClick={togglePlay}
            className={cn("transport-play", playing && "is-playing")}
          >
            {playing ? (
              <Square className="size-4 fill-current" />
            ) : (
              <Play className="size-4 fill-current" />
            )}
            <span>{playing ? "Stop" : "Play"}</span>
          </button>
          <button
            aria-label="Record notes"
            title="Record notes"
            aria-pressed={recording}
            onClick={() => setRecording(!recording)}
            className={cn("transport-icon record-button", recording && "is-recording")}
          >
            <Circle className="size-4 fill-current" />
          </button>
          <button
            aria-label="Metronome"
            title="Metronome"
            aria-pressed={metronome}
            onClick={() => setMetronome(!metronome)}
            className={cn("transport-icon", metronome && "btn-on")}
          >
            <Timer className="size-5" />
          </button>
          <button
            aria-label="Repeat"
            title={repeat ? "Repeat on: the beat loops" : "Repeat off: plays once, then stops"}
            aria-pressed={repeat}
            onClick={() => setRepeat(!repeat)}
            className={cn("transport-icon", repeat && "btn-on")}
          >
            <Repeat className="size-4" />
          </button>
          <span className="transport-divider" />
          <button
            aria-label="Undo"
            title="Undo"
            className="transport-icon undo-button"
            onClick={undo}
            disabled={!canUndo}
          >
            <Undo2 className="size-4" />
          </button>
        </div>
        <div
          className="transport-position"
          aria-label={`${loopMode === "song" ? "Song" : "Pattern"} transport`}
        >
          <span className="eyebrow">{loopMode === "song" ? "Song" : "Pattern"}
            {repeat ? " · repeat" : " · once"}
          </span>
          <span className="position-readout" aria-hidden="true">
            {String(Math.floor(Math.max(0, currentStep) / 16) + 1).padStart(2, "0")}
            <b>:</b>
            {String(Math.floor((Math.max(0, currentStep) % 16) / 4) + 1).padStart(2, "0")}
          </span>
          <span className="beat-lights" aria-hidden="true">
            {[0, 1, 2, 3].map((beat) => (
              <i
                key={beat}
                className={playing && Math.floor((currentStep % 16) / 4) === beat ? "lit" : ""}
              />
            ))}
          </span>
        </div>
        <div className="tempo-control">
          <button
            aria-label="BPM down"
            className="tempo-step"
            onClick={() => setBpm(project.bpm - 1)}
          >
            <Minus className="size-3.5" />
          </button>
          <label>
            <span className="eyebrow">BPM</span>
            <input
              aria-label="BPM"
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
            />
          </label>
          <button
            aria-label="BPM up"
            className="tempo-step"
            onClick={() => setBpm(project.bpm + 1)}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>
      {projectsOpen && <ProjectsSheet onClose={() => setProjectsOpen(false)} />}
    </header>
  );
}
