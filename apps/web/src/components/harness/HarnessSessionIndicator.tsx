import { liveHarnessSessionForThread } from "@t3tools/client-runtime/state/harness";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { Gamepad2Icon } from "lucide-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { harnessSnapshotAtom, useLiveHarnessSessionId } from "../../state/harness";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { openHarnessPlay } from "./harnessPlayStore";

/** A thread row's mark for a harness session running in its checkout; opens the play view. */
export function HarnessSessionIndicator(props: {
  readonly thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projectTitle: string;
}) {
  const gt = useGT();
  const sessionId = useLiveHarnessSessionId(props.thread);
  if (sessionId === null) return null;
  const label = gt("Harness session running");
  const open = () => {
    const snapshot = AsyncResult.getOrElse(
      appAtomRegistry.get(harnessSnapshotAtom(props.thread.environmentId)),
      () => null,
    );
    const session = liveHarnessSessionForThread(snapshot, props.thread);
    if (session === null) return;
    openHarnessPlay({
      environmentId: props.thread.environmentId,
      projectId: session.projectId,
      projectTitle: props.projectTitle,
      worktreePath: session.worktreePath,
      threadId: session.threadId,
    });
  };
  return (
    <SharedTooltipTrigger
      render={
        <button
          type="button"
          aria-label={label}
          className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm text-success-foreground outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            open();
          }}
        />
      }
      label={label}
    >
      <Gamepad2Icon aria-hidden className="size-3.5" />
    </SharedTooltipTrigger>
  );
}
