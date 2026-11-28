import type { HarnessSession } from "@t3tools/contracts";
import { isLiveHarnessSession } from "@t3tools/client-runtime/state/harness";

export type HarnessMarkBlock = "not-recorded" | "not-running" | "no-permission";

export const HARNESS_MARK_WINDOWS = [null, 10, 30, 60] as const;

/** What a session's Stop and Mark controls may do, and why Mark is off when it is. */
export function harnessSessionControls(
  session: Pick<HarnessSession, "phase" | "recorded">,
  canOperate: boolean,
) {
  const live = isLiveHarnessSession(session);
  const markBlock: HarnessMarkBlock | null = !session.recorded
    ? "not-recorded"
    : session.phase !== "running"
      ? "not-running"
      : !canOperate
        ? "no-permission"
        : null;
  return {
    live,
    canStop: canOperate && (session.phase === "starting" || session.phase === "running"),
    markBlock,
  };
}
