import { useAtomValue } from "@effect/atom-react";
import {
  createHarnessEnvironmentAtoms,
  liveHarnessSessionForThread,
} from "@t3tools/client-runtime/state/harness";
import type { EnvironmentId, HarnessSnapshot, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const harnessEnvironment = createHarnessEnvironmentAtoms(connectionAtomRuntime);

const NO_SNAPSHOT = Atom.make(AsyncResult.initial<HarnessSnapshot, never>(false)).pipe(
  Atom.withLabel("web-harness:no-snapshot"),
);

export const harnessSnapshotAtom = (environmentId: EnvironmentId | null) =>
  environmentId === null ? NO_SNAPSHOT : harnessEnvironment.snapshot({ environmentId, input: {} });

/**
 * The live session a thread's row shows, as an id so a snapshot tick that changes nothing for
 * this thread does not re-render it.
 */
export function useLiveHarnessSessionId(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}): string | null {
  return useAtomValue(
    harnessSnapshotAtom(thread.environmentId),
    (result) =>
      liveHarnessSessionForThread(
        AsyncResult.getOrElse(result, () => null),
        thread,
      )?.id ?? null,
  );
}
