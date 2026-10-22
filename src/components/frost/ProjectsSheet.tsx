import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FilePlus2, Trash2, X } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { library } from "@/lib/frost/persist";
import { cn } from "@/lib/utils";

/**
 * Project switcher: rename, open, new, delete. Projects and their audio live on this device.
 * Rendered into document.body: the top bar's backdrop-blur makes it a containing block, which would
 * otherwise pin this `fixed` sheet to the header instead of the viewport.
 */
export function ProjectsSheet({ onClose }: { onClose: () => void }) {
  const { project, commit, projectKey, openProject, newProject, notify, saveState } = useFrost();
  const [list, setList] = useState<{ key: string; name: string; savedAt: number }[]>([]);
  const refresh = () => library.list().then(setList).catch(() => setList([]));
  // Re-read whenever the open project finishes saving, so a just-started or just-renamed draft is listed.
  useEffect(() => {
    void refresh();
  }, [saveState]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center" onClick={onClose}>
      <div className="safe-bottom max-h-[85dvh] w-full overflow-y-auto rounded-t-xl bg-background p-4 sm:max-w-md sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">Projects on this device</div>
          <button aria-label="Close" className="btn size-9 min-h-9 px-0" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        {!project.isDemo && (
          <label className="mb-3 block">
            <div className="eyebrow mb-1">Name</div>
            <input className="field" value={project.name} onChange={(e) => commit((p) => ({ ...p, name: e.target.value }), { history: false })} />
          </label>
        )}
        <ul className="space-y-1">
          {list.map((p) => (
            <li key={p.key} className={cn("flex items-center gap-2 rounded-md bg-surface px-2 py-1.5", p.key === projectKey && "ring-1 ring-primary")}>
              <button
                className="min-w-0 flex-1 text-left"
                disabled={p.key === projectKey}
                onClick={() => openProject(p.key).then(onClose, (e: Error) => notify(e.message))}
              >
                <div className="truncate text-sm font-semibold">{p.name}</div>
                <div className="text-[10px] text-muted-foreground">{p.key === projectKey ? "Open now" : new Date(p.savedAt).toLocaleString()}</div>
              </button>
              {p.key !== projectKey && (
                <button
                  aria-label={`Delete ${p.name}`}
                  className="btn min-h-9 w-10 px-0"
                  onClick={() => {
                    if (confirm(`Delete “${p.name}” from this device?`)) void library.remove(p.key).then(refresh);
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          ))}
          {!list.length && <li className="text-xs text-muted-foreground">Nothing saved yet. Import a recording to start a project — it saves automatically.</li>}
        </ul>
        <button
          className="btn btn-primary mt-3 w-full"
          onClick={() => {
            newProject();
            onClose();
          }}
        >
          <FilePlus2 className="size-4" /> New project
        </button>
      </div>
    </div>,
    document.body,
  );
}
