import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { BotIcon, Gamepad2Icon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { cn, newMessageId } from "../../lib/utils";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { useFilesystemReadAccess } from "../../state/filesystem";
import { harnessEnvironment } from "../../state/harness";
import { useEnvironmentQuery } from "../../state/query";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ensureHarnessApproved } from "../../worktreeLayoutApproval";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  offersHarness,
  pickBranchCheckoutThread,
  playDisabledReason,
  playtestDisabledReason,
  PLAYTEST_PROMPT,
} from "./harnessPlay.logic";
import { openHarnessPlay } from "./harnessPlayStore";

export interface HarnessActionsThread {
  readonly id: ThreadId;
  readonly worktreePath: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * "Play this branch" and "Run playtest" for a checkout whose `t3.json` declares a harness;
 * nothing for one that declares none. Without a thread on the branch both say why they wait.
 */
function HarnessActions(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly thread: HarnessActionsThread | null;
  readonly display: "panel" | "bar";
  readonly className?: string;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { environmentId, projectId, thread } = props;
  // Describing reads the checkout's t3.json, so it needs filesystem read.
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const describe = useEnvironmentQuery(
    canReadFiles
      ? harnessEnvironment.describe({
          environmentId,
          input: thread === null ? { projectId } : { projectId, worktreePath: thread.worktreePath },
        })
      : null,
  );
  const canOperate = useAtomValue(harnessEnvironment.start.permissionAtom(environmentId));
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const description = describe.data;
  if (description === null || !offersHarness(description)) return null;

  const hasCheckout = thread !== null;
  const playReason = playDisabledReason({ description, hasCheckout, canOperate }, resolve);
  const playtestReason = playtestDisabledReason(
    { description, hasCheckout, canOperate, runtimeMode: thread?.runtimeMode ?? null },
    resolve,
  );
  const checkout =
    thread === null
      ? null
      : {
          environmentId,
          projectId,
          projectTitle: props.projectTitle,
          worktreePath: thread.worktreePath,
          threadId: thread.id,
        };

  const runPlaytest = async () => {
    if (checkout === null || thread === null || sending) return;
    setSending(true);
    const approval = await ensureHarnessApproved(checkout);
    if (approval.status !== "proceed") {
      setSending(false);
      if (approval.status === "blocked") {
        toastManager.add({
          type: "error",
          title: m(msg("Could not run the playtest")),
          description: approval.message,
        });
      }
      return;
    }
    const result = await startTurn({
      environmentId,
      input: {
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: PLAYTEST_PROMPT,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        // Behind a running turn, not steering it.
        dispatchMode: "queue",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: m(msg("Could not run the playtest")),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ??
          m(msg("The thread did not take the message.")),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: m(msg("Playtest sent to the thread's agent")),
      description: m(msg("It starts after any turn already running and stores a review packet.")),
    });
  };

  const reason = playReason ?? playtestReason;
  if (props.display === "panel") {
    return (
      <div className="flex flex-col">
        <ThreadDetailsControl
          variant="ghost"
          disabled={playReason !== null}
          onClick={() => checkout && openHarnessPlay(checkout)}
        >
          <Gamepad2Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <T>Play this branch</T>
        </ThreadDetailsControl>
        <ThreadDetailsControl
          variant="ghost"
          disabled={playtestReason !== null || sending}
          onClick={() => void runPlaytest()}
        >
          {sending ? (
            <Spinner size="md" />
          ) : (
            <BotIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          <T>Run playtest</T>
        </ThreadDetailsControl>
        {reason ? <p className="px-2.5 pb-1 text-xs text-muted-foreground">{reason}</p> : null}
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={gt("Harness")}
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", props.className)}
    >
      <Button
        size="xs"
        variant="outline"
        disabled={playReason !== null}
        onClick={() => checkout && openHarnessPlay(checkout)}
      >
        <Gamepad2Icon aria-hidden />
        <T>Play this branch</T>
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={playtestReason !== null || sending}
        onClick={() => void runPlaytest()}
      >
        {sending ? <Spinner /> : <BotIcon aria-hidden />}
        <T>Run playtest</T>
      </Button>
      {reason ? <span className="min-w-0 text-xs text-muted-foreground">{reason}</span> : null}
    </div>
  );
}

/** The actions for a thread's own checkout; nothing for a thread without a worktree. */
export function ThreadHarnessActions({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : scopeProjectRef(threadRef.environmentId, thread.projectId),
  );
  if (thread === null || thread.worktreePath === null) return null;
  return (
    <HarnessActions
      environmentId={threadRef.environmentId}
      projectId={thread.projectId}
      projectTitle={project?.title ?? ""}
      thread={{
        id: thread.id,
        worktreePath: thread.worktreePath,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      }}
      display="panel"
    />
  );
}

/** The actions for a pull request, played in the checkout of the newest thread on its branch. */
export function PullRequestHarnessActions(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly className?: string;
}) {
  const { environmentId, projectId, branch } = props;
  // Selected as text: the environment's threads change on every streamed token.
  const picked = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(environmentId),
    (threads) => {
      const thread = pickBranchCheckoutThread(threads, { projectId, branch });
      return thread === null
        ? null
        : JSON.stringify({
            id: thread.id,
            worktreePath: thread.worktreePath,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          });
    },
  );
  const project = useProject(scopeProjectRef(environmentId, projectId));
  return (
    <HarnessActions
      environmentId={environmentId}
      projectId={projectId}
      projectTitle={project?.title ?? ""}
      thread={picked === null ? null : (JSON.parse(picked) as HarnessActionsThread)}
      display="bar"
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}
