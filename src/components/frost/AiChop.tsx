import { useEffect, useRef, useState } from "react";
import { Headphones, Loader2, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFrost, uid } from "@/lib/frost/store";
import { aiSliceService, playbackService } from "@/lib/frost/engine";
import { applyAiSlices, type AiSliceResult } from "@/lib/frost/aiSlices";
import type { SourceAsset } from "@/lib/frost/types";

type ReviewSlice = AiSliceResult["slices"][number] & { padId: string; selected: boolean };

export function AiChop({ source, start, end, disabled }: { source: SourceAsset; start: number; end: number; disabled: boolean }) {
  const { project, projectKey, commit, notify } = useFrost();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [slices, setSlices] = useState<ReviewSlice[]>([]);
  const [listening, setListening] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const emptyPads = project.pads.filter((p) => p.bank === project.bank && !p.sliceId);
  const rangeLength = end - start;
  useEffect(() => {
    setConsent(false); setError(""); setSummary(""); setSlices([]); setListening(null); setBusy(false);
    return () => { abort.current?.abort(); playbackService.stopAudition(); };
  }, [source.id, projectKey, project.bank, start, end]);

  async function analyze() {
    if (!consent || disabled || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); setError(""); setSlices([]); setSummary("");
    try {
      const result = await aiSliceService.suggest(source.id, start, end, emptyPads.map((p) => p.index + 1), controller.signal);
      if (controller.signal.aborted) return;
      setSummary(result.summary);
      setSlices(result.slices.map((s) => ({ ...s, padId: `${project.bank}${s.pad}`, selected: true })));
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "AI analysis is unavailable.");
    } finally { if (abort.current === controller) setBusy(false); }
  }

  async function audition(index: number) {
    if (listening === index) { playbackService.stopAudition(); setListening(null); return; }
    const slice = slices[index];
    if (!slice) return;
    await playbackService.resume();
    if (playbackService.audition(source.id, slice.start, slice.end, () => setListening(null))) setListening(index);
    else setError("This recording is not loaded. Re-import it to listen.");
  }

  function apply() {
    try {
      commit((p) => applyAiSlices(p, source.id, slices.filter((s) => s.selected).map((s) => ({ padId: s.padId, start: s.start, end: s.end, label: s.label })), uid));
      playbackService.stopAudition(); setListening(null); setSlices([]); setSummary("");
      notify("AI chops assigned to empty pads. Undo restores the previous state.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not assign suggestions."); }
  }

  return <section className="space-y-3 border-t border-border py-4" aria-label="AI chop suggestions">
    <div className="flex items-center justify-between gap-2">
      <div className="eyebrow flex items-center gap-2"><Sparkles className="size-4 text-primary" /> AI chops</div>
      <span className="font-mono text-xs text-muted-foreground">{start.toFixed(2)}–{end.toFixed(2)}s · bank {project.bank}</span>
    </div>
    <label className="flex items-start gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
      <span>Send this audio selection to Lovable AI for analysis. Uses workspace AI credits; it is not added to the public project library.</span>
    </label>
    {rangeLength > 60 && <p role="status" className="text-xs text-muted-foreground">Select up to 60 seconds for AI analysis.</p>}
    {!emptyPads.length && <p role="status" className="text-xs text-muted-foreground">Bank {project.bank} has no empty pads.</p>}
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => void analyze()} disabled={!consent || busy || disabled || rangeLength > 60 || !emptyPads.length}>
        {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Sparkles />} {busy ? "Analyzing audio…" : "Suggest chops"}
      </Button>
      {busy && <Button variant="outline" onClick={() => { abort.current?.abort(); setBusy(false); setError("Analysis cancelled. Your sample is unchanged."); }}><Square /> Cancel</Button>}
    </div>
    {error && <p role="alert" className="break-words text-sm text-rec">{error}</p>}
    {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
    {summary && !slices.length && <p className="text-xs text-muted-foreground">No usable slices suggested. Your sample is unchanged.</p>}
    {slices.length > 0 && <>
      <ul className="divide-y divide-border">
        {slices.map((s, i) => <li key={i} className="grid grid-cols-[auto_1fr_auto] items-start gap-2 py-3">
          <input aria-label={`Use suggestion ${i + 1}`} type="checkbox" checked={s.selected} onChange={(e) => setSlices((prev) => prev.map((x, n) => n === i ? { ...x, selected: e.target.checked } : x))} className="mt-2" />
          <div className="min-w-0 space-y-1">
            <input aria-label={`Name suggestion ${i + 1}`} className="field text-sm" value={s.label} maxLength={48} onChange={(e) => setSlices((prev) => prev.map((x, n) => n === i ? { ...x, label: e.target.value } : x))} />
            <p className="break-words text-xs text-muted-foreground">{s.reason}</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs">Start <input aria-label={`Start suggestion ${i + 1}`} className="field w-24 font-mono text-xs" type="number" min={start} max={end} step="0.001" value={s.start} onChange={(e) => setSlices((prev) => prev.map((x, n) => n === i ? { ...x, start: Number(e.target.value) } : x))} /></label>
              <label className="text-xs">End <input aria-label={`End suggestion ${i + 1}`} className="field w-24 font-mono text-xs" type="number" min={start} max={end} step="0.001" value={s.end} onChange={(e) => setSlices((prev) => prev.map((x, n) => n === i ? { ...x, end: Number(e.target.value) } : x))} /></label>
              <select aria-label={`Pad suggestion ${i + 1}`} className="field w-20 text-xs" value={s.padId} onChange={(e) => setSlices((prev) => prev.map((x, n) => n === i ? { ...x, padId: e.target.value } : x))}>
                {emptyPads.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
            </div>
          </div>
          <Button variant="outline" size="icon" aria-label={`Listen to suggestion ${i + 1}`} title={`Listen to ${s.label}`} disabled={!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end > source.durationSec || s.end <= s.start} onClick={() => void audition(i)}>{listening === i ? <Square /> : <Headphones />}</Button>
        </li>)}
      </ul>
      <Button onClick={apply} disabled={!slices.some((s) => s.selected)}><Sparkles /> Assign selected chops</Button>
    </>}
  </section>;
}