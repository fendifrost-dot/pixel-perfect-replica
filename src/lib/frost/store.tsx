import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createDemoProject, createEmptyProject } from "./demo";
import { importService, transportService, playbackService } from "./engine";
import { currentKey, library } from "./persist";
import type { LoopMode } from "./services";
import type { Project } from "./types";
import { prepareStretches } from "./voice";

export type View = "sample" | "pads" | "sequence" | "song" | "export";
export type SaveState = "demo" | "saving" | "saved" | "error";

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
}

const FrostContext = createContext<Ctx | null>(null);
const newKey = () => "prj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function FrostProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<Project>(() => createDemoProject());
  const [past, setPast] = useState<Project[]>([]);
  const [view, setView] = useState<View>("pads");
  const [playing, setPlaying] = useState(false);
  const [loopMode, setLoopModeState] = useState<LoopMode>("pattern");
  const [recording, setRecording] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string>(() => newKey());
  const [saveState, setSaveState] = useState<SaveState>("demo");
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

  const stopTransport = useCallback(() => {
    if (transportService.isRunning()) transportService.stop();
    setPlaying(false);
    setCurrentStep(-1);
  }, []);

  const load = useCallback(
    async (p: Project, key: string) => {
      stopTransport();
      setPast([]);
      ref.current = p;
      setProject(p);
      setProjectKey(key);
      currentKey.set(key);
      setSaveState(p.isDemo ? "demo" : "saved");
      if (p.sources.some((s) => s.origin === "imported")) {
        setLoadingAudio(true);
        try {
          const missing = await importService.rehydrate(p);
          if (missing.length) notify(`${missing.length} recording(s) weren't stored on this device — re-import to hear those pads.`);
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

  const newProject = useCallback(() => void load(createEmptyProject(), newKey()), [load]);

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
    setSaveState("saving");
    const t = setTimeout(() => {
      library
        .save(projectKey, project)
        .then(() => {
          currentKey.set(projectKey);
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 700);
    return () => clearTimeout(t);
  }, [project, projectKey]);

  // Pre-compute pitch-preserving stretches off the tap path whenever pads / tempo change.
  useEffect(() => {
    const t = setTimeout(() => prepareStretches(project), 150);
    return () => clearTimeout(t);
  }, [project.pads, project.slices, project.bpm, audioVersion]);

  const togglePlay = useCallback(() => {
    if (transportService.isRunning()) {
      stopTransport();
    } else {
      void playbackService.resume();
      transportService.start(() => ref.current, setCurrentStep, () => metroRef.current, loopMode);
      setPlaying(true);
    }
  }, [loopMode, stopTransport]);

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
        audioVersion, bumpAudio: () => setAudioVersion((v) => v + 1), openProject, newProject,
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
