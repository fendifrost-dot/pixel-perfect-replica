import { Download, Share2 } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import type { RenderedFile } from "@/lib/frost/services";
import { cn } from "@/lib/utils";

const dbfs = (x: number) => (x <= 0 ? "−∞" : (20 * Math.log10(x)).toFixed(1)) + " dB";

/** Rendered files: save them all at once (Files / AirDrop) or download one by one. */
export function FileList({ files, title }: { files: RenderedFile[]; title: string }) {
  const { notify } = useFrost();
  const asFiles = () =>
    files.map((f) => new File([f.blob], f.name, { type: f.blob.type || "audio/wav" }));
  const canShare =
    typeof navigator !== "undefined" &&
    !!navigator.canShare &&
    files.length > 0 &&
    navigator.canShare({ files: asFiles() });
  const share = async () => {
    try {
      await navigator.share({ files: asFiles(), title });
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        notify(`Share failed: ${(e as Error).message}. Use the download buttons instead.`);
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
              <div
                className={cn(
                  "font-mono text-[10px]",
                  f.clipped ? "text-rec" : "text-muted-foreground",
                )}
              >
                {f.blob.type === "application/zip" ? (
                  `ZIP · ${(f.blob.size / 1e6).toFixed(1)} MB`
                ) : f.kind === "midi" ? (
                  `MIDI · ${(f.blob.size / 1e3).toFixed(1)} kB`
                ) : (
                  <>
                    peak {dbfs(f.peak)}
                    {f.clipped ? " · too loud (clipped)" : ""} · {(f.blob.size / 1e6).toFixed(1)} MB
                  </>
                )}
              </div>
            </div>
            <button
              aria-label={`Download ${f.name}`}
              className="btn min-h-9 w-10 px-0"
              onClick={() => download(f)}
            >
              <Download className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
