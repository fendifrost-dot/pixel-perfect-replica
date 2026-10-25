import { AudioWaveform, Grid2X2, Rows3, ArrowUpRight, Mic } from "lucide-react";
import { useFrost, type View } from "@/lib/frost/store";
import { TopBar } from "./TopBar";
import { SampleView } from "./SampleView";
import { PadsView } from "./PadsView";
import { BeatView } from "./BeatView";
import { ExportView } from "./ExportView";
import { HumStudio } from "./HumStudio";
import { cn } from "@/lib/utils";

const TABS: { id: View; label: string; detail: string; Icon: typeof Grid2X2 }[] = [
  { id: "sample", label: "Chop", detail: "Find the moment", Icon: AudioWaveform },
  { id: "pads", label: "Pads", detail: "Play your sound", Icon: Grid2X2 },
  { id: "beat", label: "Beat", detail: "Build the groove", Icon: Rows3 },
  { id: "hum", label: "Hum", detail: "Hum over your beat", Icon: Mic },
  { id: "export", label: "Export", detail: "Take it to the studio", Icon: ArrowUpRight },
];
const TITLES: Record<View, { title: string; description: string }> = {
  sample: {
    title: "The sample lab.",
    description: "A little piece of something. Something entirely new.",
  },
  pads: { title: "Make it your own.", description: "Sixteen pads. One good idea is all it takes." },
  beat: { title: "Find your pocket.", description: "Sequence steps or shape every hit on the timeline." },
  hum: { title: "Hum it in.", description: "Bring in your beat, hum or beatbox the parts, send them back to your DAW." },
  export: {
    title: "Ready for the next session.",
    description: "Your mix and individual tracks, ready for your DAW.",
  },
};
export function Workspace() {
  const { view, setView, notice, project } = useFrost();
  const tab = TABS.findIndex((t) => t.id === view);
  return (
    <div className="studio-shell">
      <TopBar />
      <div className="studio-body">
        <nav className="studio-nav safe-bottom" aria-label="Sampler workspace">
          <div className="nav-caption eyebrow">Your workspace</div>
          {TABS.map(({ id, label, detail, Icon }, i) => (
            <button
              key={id}
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
              className={cn("studio-nav-item", view === id && "is-current")}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="nav-copy">
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
              <span className="nav-number" aria-hidden="true">
                0{i + 1}
              </span>
            </button>
          ))}
          <div className="rail-note">
            <span className="frost-symbol" aria-hidden="true">
              ✳
            </span>
            <p>
              Small studio.
              <br />
              Endless possibilities.
            </p>
            <span className="eyebrow">Frost Sampler</span>
          </div>
        </nav>
        <main className="studio-main" id="workspace">
          <div className="workspace-heading">
            <div>
              <div className="eyebrow section-index">
                0{tab + 1} / {TABS[tab].label}
              </div>
              <h1>{TITLES[view].title}</h1>
              <p>{TITLES[view].description}</p>
            </div>
            <span className="session-tag">
              {project.isDemo
                ? "NEW SESSION"
                : `${project.pads.filter((p) => p.sliceId).length} SOUNDS`}
            </span>
          </div>
          {view === "sample" && <SampleView />}
          {view === "pads" && <PadsView />}
          {view === "beat" && <BeatView />}
          {view === "hum" && <HumStudio />}
          {view === "export" && <ExportView />}
        </main>
      </div>
      {notice && (
        <div role="status" className="studio-notice">
          {notice}
        </div>
      )}
    </div>
  );
}
