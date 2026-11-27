import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KeyboardMusic, X } from "lucide-react";
import { useFrost, uid } from "@/lib/frost/store";
import { playbackService, setTransportNoteSink, transportService } from "@/lib/frost/engine";
import { recordOffset } from "@/lib/frost/device";
import { midiPrefs, midiService, type MidiMessage, type MidiPortInfo } from "@/lib/frost/midiIn";
import {
  applyControl,
  bankPadIds,
  forgetNote,
  learnCc,
  learnNote,
  midiOf,
  noteMap,
  padForMidiNote,
  withRecordedHit,
} from "@/lib/frost/noteMap";
import type { MidiCcTarget } from "@/lib/frost/types";
import { cn } from "@/lib/utils";

type Learning =
  | { kind: "pad"; padId: string }
  | { kind: "bank"; padIds: string[]; index: number }
  | { kind: "cc"; target: MidiCcTarget };

interface MidiApi {
  available: boolean;
  enabled: boolean;
  toggle: () => void;
  lit: Record<string, boolean>;
  learningPadId: string | null;
  learningLabel: string | null;
  cancelLearn: () => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
}

const MidiContext = createContext<MidiApi | null>(null);

export function useMidi(): MidiApi {
  const ctx = useContext(MidiContext);
  if (!ctx) throw new Error("useMidi outside MidiProvider");
  return ctx;
}

const CC_LABEL: Record<MidiCcTarget, string> = {
  pitch: "pitch",
  volume: "volume",
  start: "chop start",
  end: "chop end",
};

export function MidiProvider({ children }: { children: ReactNode }) {
  const frost = useFrost();
  const live = useRef(frost);
  live.current = frost;
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const enabledRef = useRef(false);
  const [outputOn, setOutputOn] = useState(false);
  const outputRef = useRef(false);
  const [channel, setChannel] = useState(1);
  const channelRef = useRef(1);
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [learning, setLearningState] = useState<Learning | null>(null);
  const learningRef = useRef<Learning | null>(null);
  const [lit, setLit] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const warned = useRef(false);
  const midiRef = useRef(frost.project.midi);
  midiRef.current = frost.project.midi;
  const onMessage = useRef<(m: MidiMessage) => void>(() => {});

  const setLearning = (v: Learning | null) => {
    learningRef.current = v;
    setLearningState(v);
  };

  const flash = (padId: string) => {
    setLit((prev) => ({ ...prev, [padId]: true }));
    setTimeout(() => setLit((prev) => ({ ...prev, [padId]: false })), 140);
  };

  const playPad = (padId: string, velocity: number) => {
    const s = live.current;
    const pad = s.project.pads.find((p) => p.id === padId);
    if (!pad) return;
    const slice = s.project.slices.find((sl) => sl.id === pad.sliceId);
    const go = () => {
      flash(padId);
      if (!slice) return;
      if (!playbackService.triggerPad(pad, slice, velocity, s.project.bpm))
        s.notify(`Pad ${pad.id}: its recording isn't loaded on this device yet.`);
    };
    if (playbackService.isReady()) go();
    else
      void playbackService.resume().then((ok) => {
        if (ok) go();
        else s.notify("Audio is blocked. Tap the page once, then play the controller again.");
      });
  };

  const recordPad = (padId: string, velocity: number) => {
    const s = live.current;
    if (!s.recording || !s.playing) return;
    if (s.loopMode === "song") {
      if (!warned.current) s.notify("Recording goes into a pattern — switch Beat to Pattern.");
      warned.current = true;
      return;
    }
    const pos = transportService.positionAt(
      playbackService.heardTime() - recordOffset.get() / 1000,
    );
    if (pos == null || pos < 0) return;
    const id = uid();
    transportService.suppress(id, pos + 1);
    s.commit((p) => withRecordedHit(p, padId, velocity, pos, id));
  };

  onMessage.current = (m) => {
    const s = live.current;
    setLast(describe(m));
    const mode = learningRef.current;
    if (m.kind === "cc") {
      if (mode?.kind === "cc") {
        const target = mode.target;
        setLearning(null);
        const next = learnCc(midiOf(midiRef.current), {
          cc: m.number,
          channel: m.channel,
          target,
        });
        midiRef.current = next;
        s.commit((p) => applyControl({ ...p, midi: next }, target, m.value));
        s.notify(`CC ${m.number} on channel ${m.channel} controls ${CC_LABEL[target]}.`);
        return;
      }
      if (!enabledRef.current) return;
      const binding = midiOf(midiRef.current).ccs.find(
        (c) => c.cc === m.number && c.channel === m.channel,
      );
      if (!binding || !s.project.selectedPadId) return;
      s.commit((p) => applyControl(p, binding.target, m.value), { history: false });
      return;
    }
    if (m.kind === "noteoff") {
      if (!enabledRef.current && !mode) return;
      const id = padForMidiNote(s.project.pads, midiRef.current?.notes, m.number);
      if (!id) return;
      playbackService.releasePad(id);
      setLit((prev) => ({ ...prev, [id]: false }));
      return;
    }
    if (mode?.kind === "pad") {
      const padId = mode.padId;
      setLearning(null);
      const next = learnNote(midiOf(midiRef.current), padId, m.number);
      midiRef.current = next;
      s.commit((p) => ({ ...p, midi: next }));
      playPad(padId, m.value);
      s.notify(`${padId} is note ${m.number}.`);
      return;
    }
    if (mode?.kind === "bank") {
      const padId = mode.padIds[mode.index];
      if (!padId) {
        setLearning(null);
        return;
      }
      const nextIndex = mode.index + 1;
      const done = nextIndex >= mode.padIds.length;
      const next = learnNote(midiOf(midiRef.current), padId, m.number);
      midiRef.current = next;
      s.commit((p) => ({
        ...p,
        midi: next,
        selectedPadId: padId,
      }));
      playPad(padId, m.value);
      if (done) {
        setLearning(null);
        s.notify("The bank is mapped.");
      } else {
        const upcoming = mode.padIds[nextIndex]!;
        setLearning({ kind: "bank", padIds: mode.padIds, index: nextIndex });
        s.notify(`${padId} is note ${m.number}. Hit a key for ${upcoming}.`);
      }
      return;
    }
    if (!enabledRef.current) return;
    const id = padForMidiNote(s.project.pads, midiRef.current?.notes, m.number);
    if (!id) return;
    playPad(id, m.value);
    recordPad(id, m.value);
  };

  const turnOn = async () => {
    enabledRef.current = true;
    setEnabled(true);
    midiPrefs.setInputOn(true);
    setError(null);
    try {
      await midiService.startInput((m) => onMessage.current(m));
      const connected = midiService.inputs().filter((p) => p.state === "connected");
      if (!midiPrefs.inputId() && connected.length !== 1) setSettingsOpen(true);
    } catch (e) {
      enabledRef.current = false;
      setEnabled(false);
      midiPrefs.setInputOn(false);
      midiService.stopInput();
      setError((e as Error).message);
      setSettingsOpen(true);
    }
  };
  const turnOnRef = useRef(turnOn);
  turnOnRef.current = turnOn;

  const turnOff = () => {
    enabledRef.current = false;
    setEnabled(false);
    midiPrefs.setInputOn(false);
    setLearning(null);
    midiService.stopInput();
  };

  useEffect(() => {
    if (!midiService.available()) return;
    setAvailable(true);
    const out = midiPrefs.outputOn();
    outputRef.current = out;
    setOutputOn(out);
    const ch = midiPrefs.channel();
    channelRef.current = ch;
    setChannel(ch);
    setOffset(midiPrefs.offsetMs());
    const unsub = midiService.subscribe(() => setTick((t) => t + 1));
    setTransportNoteSink({
      onNote: (n) => {
        if (!outputRef.current) return;
        const s = live.current;
        const mapped = noteMap(s.project.pads, s.project.midi?.notes).find(
          (m) => m.padId === n.padId,
        );
        if (!mapped) return;
        midiService.send(mapped.note, n.velocity, n.when, n.off, channelRef.current);
      },
      onStop: () => {
        if (outputRef.current) midiService.allNotesOff(channelRef.current);
      },
    });
    if (midiPrefs.inputOn()) void turnOnRef.current();
    if (out) void midiService.ensureAccess().catch(() => undefined);
    return () => {
      unsub();
      midiService.stopInput();
      setTransportNoteSink(null);
    };
  }, []);

  const learningPadId =
    learning?.kind === "pad"
      ? learning.padId
      : learning?.kind === "bank"
        ? (learning.padIds[learning.index] ?? null)
        : null;
  const learningLabel =
    learning?.kind === "pad"
      ? `Hit a key or pad for ${learning.padId}.`
      : learning?.kind === "bank"
        ? `Hit a key for ${learning.padIds[learning.index] ?? "the next pad"} (${learning.index + 1}/${learning.padIds.length}).`
        : learning?.kind === "cc"
          ? `Move a knob to control ${CC_LABEL[learning.target]}.`
          : null;

  const api: MidiApi = {
    available,
    enabled,
    toggle: () => void (enabledRef.current ? turnOff() : turnOn()),
    lit,
    learningPadId,
    learningLabel,
    cancelLearn: () => setLearning(null),
    settingsOpen,
    setSettingsOpen,
  };

  return (
    <MidiContext.Provider value={api}>
      {children}
      {available && settingsOpen && (
        <MidiSheet
          tick={tick}
          error={error}
          last={last}
          enabled={enabled}
          outputOn={outputOn}
          channel={channel}
          offset={offset}
          learning={learning}
          onClose={() => setSettingsOpen(false)}
          onOutput={async (on) => {
            outputRef.current = on;
            setOutputOn(on);
            midiPrefs.setOutputOn(on);
            if (!on) {
              midiService.allNotesOff(channelRef.current);
              return;
            }
            try {
              await midiService.ensureAccess();
              setError(null);
            } catch (e) {
              outputRef.current = false;
              setOutputOn(false);
              midiPrefs.setOutputOn(false);
              setError((e as Error).message);
            }
          }}
          onChannel={(n) => {
            channelRef.current = n;
            setChannel(n);
            midiPrefs.setChannel(n);
          }}
          onOffset={(n) => {
            setOffset(n);
            midiPrefs.setOffsetMs(n);
          }}
          onLearnPad={async () => {
            const padId = live.current.project.selectedPadId;
            if (!padId) {
              frost.notify("Select a pad first.");
              return;
            }
            if (!enabledRef.current) await turnOn();
            if (!enabledRef.current) return;
            setLearning({ kind: "pad", padId });
            setSettingsOpen(false);
            frost.notify(`Hit a key or pad for ${padId}.`);
          }}
          onLearnBank={async () => {
            const ids = bankPadIds(live.current.project.pads, live.current.project.bank);
            if (!ids.length) return;
            if (!enabledRef.current) await turnOn();
            if (!enabledRef.current) return;
            setLearning({ kind: "bank", padIds: ids, index: 0 });
            setSettingsOpen(false);
            frost.notify(
              `Hit a key for ${ids[0]}. The rest of bank ${live.current.project.bank} follows.`,
            );
          }}
          onLearnCc={async (target) => {
            if (!live.current.project.selectedPadId) {
              frost.notify("Select a pad first.");
              return;
            }
            if (!enabledRef.current) await turnOn();
            if (!enabledRef.current) return;
            setLearning({ kind: "cc", target });
            setSettingsOpen(false);
            frost.notify(`Move a knob to control ${CC_LABEL[target]}.`);
          }}
          onForget={(padId) =>
            frost.commit((p) => ({ ...p, midi: forgetNote(midiOf(p.midi), padId) }))
          }
          onReset={() =>
            frost.commit((p) => ({ ...p, midi: { notes: {}, ccs: midiOf(p.midi).ccs } }))
          }
        />
      )}
    </MidiContext.Provider>
  );
}

function describe(m: MidiMessage): string {
  if (m.kind === "cc") return `CC ${m.number} · channel ${m.channel} · ${m.value}`;
  if (m.kind === "noteoff") return `Note ${m.number} off · channel ${m.channel}`;
  return `Note ${m.number} · channel ${m.channel} · velocity ${m.value}`;
}

function MidiSheet({
  tick,
  error,
  last,
  enabled,
  outputOn,
  channel,
  offset,
  learning,
  onClose,
  onOutput,
  onChannel,
  onOffset,
  onLearnPad,
  onLearnBank,
  onLearnCc,
  onForget,
  onReset,
}: {
  tick: number;
  error: string | null;
  last: string | null;
  enabled: boolean;
  outputOn: boolean;
  channel: number;
  offset: number;
  learning: Learning | null;
  onClose: () => void;
  onOutput: (on: boolean) => void;
  onChannel: (n: number) => void;
  onOffset: (n: number) => void;
  onLearnPad: () => void;
  onLearnBank: () => void;
  onLearnCc: (target: MidiCcTarget) => void;
  onForget: (padId: string) => void;
  onReset: () => void;
}) {
  const { project } = useFrost();
  void tick;
  const inputs = midiService.inputs().filter((p) => p.state === "connected");
  const outputs = midiService.outputs().filter((p) => p.state === "connected");
  const chosenIn = midiPrefs.inputId();
  const chosenOut = midiPrefs.outputId();
  const rows = noteMap(project.pads, project.midi?.notes).filter((m) => {
    const pad = project.pads.find((p) => p.id === m.padId);
    return pad?.bank === project.bank;
  });
  const status = error
    ? error
    : !enabled
      ? "MIDI input is off."
      : !chosenIn
        ? inputs.length
          ? `${inputs.length} inputs connected. Choose one.`
          : "No MIDI input is connected."
        : inputs.some((p) => p.id === chosenIn)
          ? `Listening to ${inputs.find((p) => p.id === chosenIn)?.name}.`
          : "The chosen input is unplugged.";
  const [offsetText, setOffsetText] = useState<string | null>(null);

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/50 sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        className="safe-bottom max-h-[85dvh] w-full overflow-y-auto rounded-t-xl bg-background p-4 sm:max-w-md sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="MIDI"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">MIDI</div>
          <button aria-label="Close" className="btn size-9 min-h-9 px-0" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <p className={cn("text-xs", error ? "text-rec" : "text-muted-foreground")}>{status}</p>
        {last && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{last}</p>}
        {learning && (
          <p className="mt-2 text-xs text-primary">
            {learning.kind === "cc"
              ? `Move a knob for ${CC_LABEL[learning.target]}.`
              : learning.kind === "pad"
                ? `Hit a key for ${learning.padId}.`
                : `Learning bank, pad ${learning.index + 1} of ${learning.padIds.length}.`}
          </p>
        )}

        <div className="eyebrow mb-1 mt-4">Input</div>
        <PortList
          ports={inputs}
          chosen={chosenIn}
          empty="Connect a controller, then turn MIDI input on."
          onPick={(id) => midiPrefs.setInputId(id)}
        />

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="btn text-xs" onClick={onLearnPad}>
            Learn selected pad
          </button>
          <button className="btn text-xs" onClick={onLearnBank}>
            Learn bank {project.bank}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Notes start at 36 and follow the pads in bank order. Learn assigns the next key you hit.
          Knobs edit the selected pad.
        </p>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {(["pitch", "volume", "start", "end"] as const).map((target) => (
            <button key={target} className="btn px-1 text-[10px]" onClick={() => onLearnCc(target)}>
              {CC_LABEL[target]}
            </button>
          ))}
        </div>

        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto">
          {rows.map((row) => {
            const learned = project.midi?.notes[row.padId] != null;
            const name = project.slices.find(
              (s) => s.id === project.pads.find((p) => p.id === row.padId)?.sliceId,
            )?.name;
            return (
              <li key={row.padId} className="flex items-center gap-2 text-xs">
                <span className="w-8 font-mono">{row.note}</span>
                <span className="w-8 font-mono">{row.padId}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {name ?? "Empty"}
                </span>
                {learned && (
                  <button
                    className="btn min-h-7 px-2 text-[10px]"
                    onClick={() => onForget(row.padId)}
                  >
                    Default
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <button className="btn mt-2 w-full text-xs" onClick={onReset}>
          Reset notes to the default
        </button>

        <div className="eyebrow mb-1 mt-4">Output to the DAW</div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          Sends the pattern's notes to a MIDI port, using this same map. Turn input off while the
          DAW records, so a pad plays once. This does not lock tempo: the DAW keeps its own clock.
        </p>
        <button
          className={cn("btn mb-2 w-full text-xs", outputOn && "btn-on")}
          aria-pressed={outputOn}
          onClick={() => onOutput(!outputOn)}
        >
          {outputOn ? "Note output on" : "Note output off"}
        </button>
        <PortList
          ports={outputs}
          chosen={chosenOut}
          empty="No MIDI output is connected. On a Mac, an IAC bus from Audio MIDI Setup shows up here."
          onPick={(id) => midiPrefs.setOutputId(id)}
        />
        <div className="mt-2 flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Channel</span>
            <select
              className="field w-16"
              aria-label="MIDI output channel"
              value={channel}
              onChange={(e) => onChannel(Number(e.target.value))}
            >
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 items-center gap-2 text-xs">
            <span className="text-muted-foreground">Offset ms</span>
            <input
              className="field w-20 font-mono"
              aria-label="MIDI output offset in milliseconds"
              inputMode="numeric"
              value={offsetText ?? String(offset)}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setOffsetText(e.target.value.replace(/[^\d-]/g, ""))}
              onBlur={() => {
                if (offsetText == null) return;
                const n = Number(offsetText);
                setOffsetText(null);
                if (offsetText.trim() !== "" && Number.isFinite(n))
                  onOffset(Math.max(-200, Math.min(200, Math.round(n))));
              }}
            />
          </label>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PortList({
  ports,
  chosen,
  empty,
  onPick,
}: {
  ports: MidiPortInfo[];
  chosen: string | null;
  empty: string;
  onPick: (id: string) => void;
}) {
  if (!ports.length) return <p className="text-[11px] text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1">
      {ports.map((p) => (
        <li key={p.id}>
          <button
            className={cn("btn w-full justify-start text-xs", chosen === p.id && "btn-on")}
            aria-pressed={chosen === p.id}
            onClick={() => onPick(p.id)}
          >
            <KeyboardMusic className="size-3.5 shrink-0" />
            <span className="truncate">{p.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
