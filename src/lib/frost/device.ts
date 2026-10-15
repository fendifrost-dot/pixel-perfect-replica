/** Per-device settings (not part of a project): kept in localStorage. */
const OFFSET_KEY = "frost-sampler:record-offset-ms";

export const recordOffset = {
  get(): number {
    try {
      return Number(localStorage.getItem(OFFSET_KEY)) || 0;
    } catch {
      return 0;
    }
  },
  set(ms: number) {
    try {
      localStorage.setItem(OFFSET_KEY, String(ms));
    } catch {
      /* private mode */
    }
  },
};
