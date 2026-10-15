import { Lock } from "lucide-react";

/** Honest disabled control for features without a real engine yet. */
export function Unavailable({ label, reason }: { label: string; reason: string }) {
  if (!reason) return null;
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed px-3 py-2">
      <button className="btn min-h-9 shrink-0 text-xs" disabled>
        <Lock className="size-3.5" /> {label}
      </button>
      <span className="text-[11px] leading-tight text-muted-foreground">{reason}</span>
    </div>
  );
}
