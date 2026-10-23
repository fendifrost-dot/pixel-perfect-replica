import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, FilePlus2, RefreshCw, Trash2, X } from "lucide-react";
import { useFrost } from "@/lib/frost/store";
import { library } from "@/lib/frost/persist";
import { cloudKey } from "@/lib/frost/cloud";
import { deleteEverywhere, testKey } from "@/lib/frost/sync";
import { cn } from "@/lib/utils";

/**
 * Project switcher: rename, open, new, delete — plus Cloud sync (the key that lets Claude, Grok and
 * ChatGPT work on these projects through the MCP). Projects and audio always stay on this device too.
 * Rendered into document.body: the top bar's backdrop-blur makes it a containing block, which would
 * otherwise pin this `fixed` sheet to the header instead of the viewport.
 */
export function ProjectsSheet({ onClose }: { onClose: () => void }) {
  const { project, commit, projectKey, openProject, newProject, notify, saveState, syncNow, syncTick } = useFrost();
  const [list, setList] = useState<{ key: string; name: string; savedAt: number }[]>([]);
  const refresh = () => library.list().then(setList).catch(() => setList([]));
  // Re-read whenever the open project finishes saving, so a just-started or just-renamed draft is listed.
  useEffect(() => {
    void refresh();
  }, [saveState, syncTick]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center" onClick={onClose}>
      <div className="safe-bottom max-h-[85dvh] w-full overflow-y-auto rounded-t-xl bg-background p-4 sm:max-w-md sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">Projects</div>
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
                    if (confirm(`Delete “${p.name}”${cloudKey.get() ? " from this device and the cloud" : " from this device"}?`)) void deleteEverywhere(p.key).then(refresh);
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
        <CloudSync onSynced={() => void syncNow().then(refresh)} />
      </div>
    </div>,
    document.body,
  );
}

/** Cloud sync: one key, shared with the MCP. Stored only on this device. */
function CloudSync({ onSynced }: { onSynced: () => void }) {
  const [key, setKey] = useState(() => cloudKey.get() ?? "");
  const [state, setState] = useState<"off" | "checking" | "ok" | "wrong" | "not-set-up" | "offline">(cloudKey.get() ? "checking" : "off");
  useEffect(() => {
    const k = cloudKey.get();
    if (k) void testKey(k).then(setState);
  }, []);
  const save = async () => {
    const k = key.trim();
    if (!k) {
      cloudKey.set(null);
      setState("off");
      return;
    }
    setState("checking");
    const r = await testKey(k);
    setState(r);
    if (r === "ok") {
      cloudKey.set(k);
      onSynced();
    }
  };
  const label = {
    off: "Off — projects stay on this phone only.",
    checking: "Checking…",
    ok: "On — synced with the cloud. Assistants connected to the Frost MCP see these projects.",
    wrong: "That key doesn't match the FROST_MCP_KEY secret.",
    "not-set-up": "The cloud has no FROST_MCP_KEY secret yet (Lovable Cloud → Secrets).",
    offline: "Can't reach the cloud right now.",
  }[state];
  return (
    <section className="mt-4 space-y-2 border-t pt-3">
      <div className="flex items-center gap-2">
        <Cloud className={cn("size-4", state === "ok" ? "text-teal" : "text-muted-foreground")} />
        <span className="eyebrow">Cloud sync</span>
      </div>
      <div className="flex gap-2">
        <input
          className="field min-w-0 flex-1 font-mono text-xs"
          type="password"
          autoComplete="off"
          placeholder="Frost key (FROST_MCP_KEY)"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="btn min-h-10 px-3 text-xs" onClick={() => void save()}>
          {cloudKey.get() && key.trim() === cloudKey.get() ? <RefreshCw className="size-4" /> : "Save"}
        </button>
      </div>
      <p className={cn("text-[11px]", state === "ok" ? "text-muted-foreground" : state === "off" || state === "checking" ? "text-muted-foreground" : "text-rec")}>{label}</p>
    </section>
  );
}
