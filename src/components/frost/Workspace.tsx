import { AudioWaveform, Grid3x3, Rows3, Share } from "lucide-react";
import { useFrost, type View } from "@/lib/frost/store";
import { TopBar } from "./TopBar";
import { SampleView } from "./SampleView";
import { PadsView } from "./PadsView";
import { BeatView } from "./BeatView";
import { ExportView } from "./ExportView";
import { cn } from "@/lib/utils";

const TABS: { id: View; label: string; Icon: typeof Grid3x3 }[] = [
  { id: "sample", label: "Chop", Icon: AudioWaveform },
  { id: "pads", label: "Pads", Icon: Grid3x3 },
  { id: "beat", label: "Beat", Icon: Rows3 },
  { id: "export", label: "Export", Icon: Share },
];

export function Workspace() {
  const { view, setView, notice } = useFrost();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col">
      <TopBar />
      <main className="flex-1 px-3 pb-28 pt-3">
        {view === "sample" && <SampleView />}
        {view === "pads" && <PadsView />}
        {view === "beat" && <BeatView />}
        {view === "export" && <ExportView />}
      </main>
      {notice && (
        <div className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md rounded-md bg-popover px-4 py-3 text-sm shadow-lg ring-1 ring-border">
          {notice}
        </div>
      )}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto grid max-w-5xl grid-cols-4">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold",
                view === id ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
