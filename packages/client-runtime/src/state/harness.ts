import {
  type HarnessSession,
  type HarnessSnapshot,
  type ProjectId,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * @public The play view and project settings in web and mobile call these.
 *
 * A project's harness, per environment: one subscription carries every session the server
 * started and every running setup, so commands never patch state themselves.
 */
export function createHarnessEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:harness:snapshot",
    tag: WS_METHODS.harnessSubscribe,
  });
  return {
    snapshot,
    /** Whether a checkout declares a harness, and whether it may run for a person here. */
    describe: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:harness:describe",
      tag: WS_METHODS.harnessDescribe,
      refreshTrigger: ({ environmentId }) => snapshot({ environmentId, input: {} }),
    }),
    /** Runs the project's `doctor --json`, which is its own code: a command, run when asked. */
    doctor: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:doctor",
      tag: WS_METHODS.harnessDoctor,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:start",
      tag: WS_METHODS.harnessStart,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:stop",
      tag: WS_METHODS.harnessStop,
    }),
    mark: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:mark",
      tag: WS_METHODS.harnessMark,
    }),
    viewer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:viewer",
      tag: WS_METHODS.harnessViewer,
    }),
    setup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:setup",
      tag: WS_METHODS.harnessSetup,
    }),
    packet: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:harness:packet",
      tag: WS_METHODS.harnessPacket,
    }),
  };
}

const LIVE_PHASES: ReadonlySet<HarnessSession["phase"]> = new Set([
  "starting",
  "running",
  "stopping",
]);

export const isLiveHarnessSession = (session: Pick<HarnessSession, "phase">) =>
  LIVE_PHASES.has(session.phase);

/** The live session a thread started, or the one running in its checkout. */
export function liveHarnessSessionForThread(
  snapshot: HarnessSnapshot | null | undefined,
  thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  },
): HarnessSession | null {
  return (
    snapshot?.sessions.find(
      (session) =>
        isLiveHarnessSession(session) &&
        (session.threadId === thread.id ||
          (thread.worktreePath !== null &&
            session.projectId === thread.projectId &&
            session.worktreePath === thread.worktreePath)),
    ) ?? null
  );
}
