import { create } from "zustand";

import type { HarnessCheckout } from "./harnessPlay.logic";

/**
 * The checkout the play view shows. `open` goes false on close while `checkout` stays, so the
 * closing dialog keeps its content; closing leaves a running session running.
 */
export const useHarnessPlayStore = create<{
  readonly checkout: HarnessCheckout | null;
  readonly open: boolean;
}>(() => ({ checkout: null, open: false }));

export function openHarnessPlay(checkout: HarnessCheckout): void {
  useHarnessPlayStore.setState({ checkout, open: true });
}

export function closeHarnessPlay(): void {
  useHarnessPlayStore.setState({ open: false });
}
