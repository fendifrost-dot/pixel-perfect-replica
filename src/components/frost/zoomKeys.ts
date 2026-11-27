import { useEffect, useRef } from "react";
import { isTypingTarget, zoomCommand, type ZoomCommand } from "@/lib/frost/waveView";

/**
 * Pro Tools zoom keys for whichever view is on screen: T / R and ⌘] / ⌘[ zoom in / out, ⌥A shows
 * everything, ⌥F fills the view with the selection. Ignored while typing in a field or while a
 * sheet (dialog) is open. `onZoom` returns false when it did nothing, so the key falls through.
 */
export function useZoomKeys(onZoom: (cmd: ZoomCommand) => boolean | void, active = true) {
  const handler = useRef(onZoom);
  handler.current = onZoom;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const cmd = zoomCommand(e);
      if (!cmd) return;
      if (handler.current(cmd) === false) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

/** The keys, for the on-screen hint. */
export const ZOOM_KEYS_HINT = "Zoom: T in · R out · ⌘] / ⌘[ · ⌥A show all · ⌥F fit selection";
