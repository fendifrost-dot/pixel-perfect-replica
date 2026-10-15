import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createDemoProject } from "./demo";
import { transportService, playbackService } from "./engine";
import type { Project } from "./types";

export type View = "sample" | "pads" | "sequence" | "song" | "export";

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
  recording: boolean;
  setRecording: (v: boolean) => void;
  metronome: boolean;
  setMetronome: (v: boolean) => void;
  currentStep: number;
  notice: string | null;
  notify: (msg: string) => void;
}

const FrostContext = createContext<Ctx | null>(null);

export function FrostProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<Project>(() => createDemoProject());
  const [past, setPast] = useState<Project[]>([]);
  const [view, setView] = useState<View>("pads");
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef(project);
  ref.current = project;
  const metroRef = useRef(metronome);
  metroRef.current = metronome;
  const lastCommit = useRef(0);

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

  const replace = useCallback((p: Project) => {
    setPast([]);
    ref.current = p;
    setProject(p);
  }, []);

  const togglePlay = useCallback(() => {
    if (transportService.isRunning()) {
      transportService.stop();
      setPlaying(false);
      setCurrentStep(-1);
    } else {
      void playbackService.resume();
      transportService.start(() => ref.current, setCurrentStep, () => metroRef.current);
      setPlaying(true);
    }
  }, []);

  useEffect(() => () => transportService.stop(), []);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 3200);
  }, []);

  return (
    <FrostContext.Provider
      value={{
        project, commit, replace, undo, canUndo: past.length > 0, view, setView, playing, togglePlay,
        recording, setRecording, metronome, setMetronome, currentStep, notice, notify,
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
