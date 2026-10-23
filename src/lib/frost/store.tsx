import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createEmptyProject } from "./demo";
import { importService, transportService, playbackService } from "./engine";
import { currentKey, library } from "./persist";
import type { LoopMode } from "./services";
import { patternSections, songSections } from "./timing";
import type { Project } from "./types";
import { prepareStretches } from "./voice";
import { pullAll, pushProject, syncEnabled } from "./sync";
import { keepView } from "./merge";
import { audioStore } from "./audioStore";

export type View = "sample" | "pads" | "beat" | "export";
/** "new" = a blank project nothing has been imported into yet (not saved). */
export type SaveState = "new" | "saving" | "saved" | "error";

/** A fresh, unsaved project. `isDemo` marks it as not-yet-started so autosave skips it until audio is imported. */
const freshProject = () => ({ ...createEmptyProject(), isDemo: true });

interface Ctx {
  project: Project;
  /** Apply an update. history=false for continuous gestures (sliders). */
  commit: (fn: (p: Project) => Project, opts?: { history?: boolean }) => void;
  replace: (p: Project) => void;
  undo: () => void;
  canUndo: boolean;
  view: View;
  setView: (v: View) => void;
  playing: boolean;
  togglePlay: () => void;
  loopMode: LoopMode;
  setLoopMode: (m: LoopMode) => void;
  recording: boolean;
  setRecording: (v: boolean) => void;
  metronome: boolean;
  setMetronome: (v: boolean) => void;
  currentStep: number;
  notice: string | null;
  notify: (msg: string) => void;
  /** IndexedDB key of the open project. */
  projectKey: string;
  saveState: SaveState;
  /** True while a reopened project's audio is being decoded. */
  loadingAudio: boolean;
  /** Bumped when decoded audio changes (import / reopen), so views re-read audioStore. */
  audioVersion: number;
  bumpAudio: () => void;
  openProject: (key: string) => Promise<void>;
  newProject: () => void;
  /** Pull/push with the cloud now (no-op when Cloud sync is off). */
  syncNow: () => Promise<void>;
  /** Bumped after each successful sync, so lists re-read the library. */
  syncTick: number;
}

const FrostContext = createContext<Ctx | null>(null);
const newKey = () => "prj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function FrostProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<Project>(freshProject);
  const [past, setPast] = useState<Project[]>([]);
  const [view, setView] = useState<View>("sample");
  const [playing, setPlaying] = useState(false);
  const [loopMode, setLoopModeState] = useState<LoopMode>("pattern");
  const [recording, setRecording] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string>(() => newKey());
  const [saveState, setSaveState] = useState<SaveState>("new");
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioVersion, setAudioVersion] = useState(0);
  const ref = useRef(project);
  ref.current = project;
  const metroRef = useRef(metronome);
  metroRef.current = metronome;
  const lastCommit = useRef(0);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 3600);
  }, []);

  const commit = useCallback<Ctx["commit"]>((fn, opts) => {
    const prev = ref.current;
    const next = fn(prev);
    if (next === prev) return;
    const now = Date.now();
    // coalesce rapid non-history updates into one undo step
    if (opts?.history !== false || now - lastCommit.current > 600) setPast((h) => [...h.slice(-49), prev]);
    lastCommit.current = opts?.history === false ? now : 0;
    ref.current = next;
    setProject(next);
  }, []);

  const undo = useCallback(() => {
    setPast((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      ref.current = prev;
      setProject(prev);
      return h.slice(0, -1);
    });
  }, []);

  /** True while Play is previewing the recording because the beat has nothing to play yet. */
  const previewing = useRef(false);

  const stopTransport = useCallback(() => {
    if (transportService.isRunning()) transportService.stop();
    if (previewing.current) {
      previewing.current = false;
      playbackService.stopAudition();
    }
    setPlaying(false);
    setCurrentStep(-1);
  }, []);

  /** Recordings added by an assistant arrive without length/rate; fill them in once decoded. */
  const fillSourceInfo = () => {
    const p = ref.current;
    const fixes = p.sources.filter((s) => s.origin === "imported" && !s.durationSec && audioStore.getBuffer(s.id));
    if (!fixes.length) return;
    const next = {
      ...p,
      sources: p.sources.map((s) => {
        const b = fixes.includes(s) ? audioStore.getBuffer(s.id)! : null;
        return b ? { ...s, durationSec: b.duration, sampleRate: b.sampleRate, channels: b.numberOfChannels } : s;
      }),
    };
    ref.current = next;
    setProject(next);
  };

  /** True for the one save that follows taking the cloud's copy (it is already in the library). */
  const skipSave = useRef(false);

  /** The project object last written to the library (newer in-memory edits are still pending). */
  const savedRef = useRef<Project | null>(null);

  /**
   * Take a newer copy of the open project (with an assistant's changes) without leaving the current
   * tab, interrupting playback, or losing the selection / open pad. Skipped while a local edit is still
   * waiting to save — the next save merges it instead.
   */
  const adopt = useCallback(async (incoming: Project) => {
    if (savedRef.current && ref.current !== savedRef.current) return false;
    const p = keepView(ref.current, incoming);
    skipSave.current = true;
    savedRef.current = p;
    ref.current = p;
    setProject(p);
    if (p.sources.some((s) => s.origin !== "demo" && !audioStore.hasBuffer(s.id))) {
      setLoadingAudio(true);
      try {
        await importService.rehydrate(p);
        fillSourceInfo();
      } finally {
        setLoadingAudio(false);
        setAudioVersion((v) => v + 1);
      }
    }
    return true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    async (p: Project, key: string) => {
      stopTransport();
      setPast([]);
      ref.current = p;
      savedRef.current = p;
      setProject(p);
      setProjectKey(key);
      currentKey.set(key);
      setSaveState(p.isDemo ? "new" : "saved");
      setView(p.sources.length ? "pads" : "sample");
      if (p.sources.some((s) => s.origin === "imported")) {
        setLoadingAudio(true);
        try {
          const missing = await importService.rehydrate(p);
          if (missing.length) notify(`${missing.length} recording(s) aren't on this device${syncEnabled() ? " or in the cloud" : ""} — re-import to hear those pads.`);
          fillSourceInfo();
        } finally {
          setLoadingAudio(false);
          setAudioVersion((v) => v + 1);
        }
      }
    },
    [notify, stopTransport],
  );

  const replace = useCallback((p: Project) => void load(p, newKey()), [load]);

  const openProject = useCallback(
    async (key: string) => {
      const p = await library.load(key);
      if (!p) throw new Error("Project not found on this device");
      await load(p, key);
    },
    [load],
  );

  const newProject = useCallback(() => void load(freshProject(), newKey()), [load]);

  // Reopen the last project on launch.
  useEffect(() => {
    const k = currentKey.get();
    if (!k) return;
    openProject(k).catch(() => {
      /* first run, or storage cleared: stay on the demo */
    });
  }, [openProject]);

  // Autosave (debounced). The demo is never saved.
  useEffect(() => {
    if (project.isDemo) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    setSaveState("saving");
    const t = setTimeout(() => {
      library
        .save(projectKey, project)
        .then(async () => {
          savedRef.current = project;
          currentKey.set(projectKey);
          setSaveState("saved");
          if (!syncEnabled()) return;
          const r = await pushProject(projectKey);
          if (r.ok && r.merged && projectKey === currentKey.get() && (await adopt(r.merged)))
            notify("Merged with changes from an assistant.");
        })
        .catch(() => setSaveState("error"));
    }, 700);
    return () => clearTimeout(t);
  }, [project, projectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull assistant edits: on launch, when the app comes back to the front, and every 20 s while open.
  const keyRef = useRef(projectKey);
  keyRef.current = projectKey;
  const syncNow = useCallback(async () => {
    if (!syncEnabled() || document.visibilityState !== "visible") return;
    try {
      const { changed, removed } = await pullAll();
      const k = keyRef.current;
      if (removed.includes(k)) {
        notify("This project was deleted from the cloud.");
        await load({ ...createEmptyProject(), isDemo: true }, newKey());
      } else if (changed.includes(k)) {
        const p = await library.load(k);
        if (p && (await adopt(p))) notify("Updated with changes from an assistant.");
      }
      setSyncTick((n) => n + 1);
    } catch {
      /* offline or wrong key: shown in Projects → Cloud sync */
    }
  }, [adopt, notify]); // eslint-disable-line react-hooks/exhaustive-deps
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => {
    void syncNow();
    const onVis = () => void syncNow();
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(() => void syncNow(), 20000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
    };
  }, [syncNow]);

  // Pre-compute pitch-preserving stretches off the tap path whenever pads / tempo change.
  useEffect(() => {
    const t = setTimeout(() => prepareStretches(project), 150);
    return () => clearTimeout(t);
  }, [project.pads, project.slices, project.bpm, audioVersion]);

  const togglePlay = useCallback(() => {
    if (transportService.isRunning() || previewing.current) {
      stopTransport();
      return;
    }
    void playbackService.resume();
    const p = ref.current;
    const sections = loopMode === "song" ? songSections(p) : patternSections(p, 1);
    const padHasAudio = new Set(p.pads.filter((x) => x.sliceId).map((x) => x.id));
    const hasHits = sections.some((s) => s.pattern.notes.some((n) => padHasAudio.has(n.padId)));
    if (hasHits) {
      transportService.start(() => ref.current, setCurrentStep, () => metroRef.current, loopMode);
      setPlaying(true);
      return;
    }
    // Nothing sequenced yet: Play previews the recording instead of silently doing nothing.
    const src = p.sources.find((s) => s.id === p.activeSourceId && s.origin !== "kit") ?? p.sources.find((s) => s.origin !== "kit");
    if (!src) {
      notify(p.pads.some((x) => x.sliceId) ? "Tap steps on Beat (or ● and play the pads) — then Play plays your beat." : "Add drums on Beat or import a recording on Chop — Play plays your beat.");
      return;
    }
    const sel = p.selection?.sourceId === src.id && p.selection.end - p.selection.start > 0.05 ? p.selection : null;
    const start = sel ? sel.start : 0;
    const end = sel ? sel.end : src.durationSec;
    const started = playbackService.audition(src.id, start, end, () => {
      if (!previewing.current) return;
      previewing.current = false;
      setPlaying(false);
    });
    if (!started) {
      notify("This recording's audio isn't loaded. Re-import it.");
      return;
    }
    previewing.current = true;
    setPlaying(true);
    notify(sel ? "No hits in the beat yet — playing your selection." : "No hits in the beat yet — playing the recording.");
  }, [loopMode, notify, stopTransport]);

  const setLoopMode = useCallback(
    (m: LoopMode) => {
      setLoopModeState(m);
      if (transportService.isRunning()) {
        transportService.stop();
        transportService.start(() => ref.current, setCurrentStep, () => metroRef.current, m);
      }
    },
    [],
  );

  useEffect(() => () => transportService.stop(), []);

  return (
    <FrostContext.Provider
      value={{
        project, commit, replace, undo, canUndo: past.length > 0, view, setView, playing, togglePlay, loopMode, setLoopMode,
        recording, setRecording, metronome, setMetronome, currentStep, notice, notify, projectKey, saveState, loadingAudio,
        audioVersion, bumpAudio: () => setAudioVersion((v) => v + 1), openProject, newProject, syncNow, syncTick,
      }}
    >
      {children}
    </FrostContext.Provider>
  );
}

export function useFrost() {
  const c = useContext(FrostContext);
  if (!c) throw new Error("useFrost outside FrostProvider");
  return c;
}

export const uid = () => Math.random().toString(36).slice(2, 10);
export const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
