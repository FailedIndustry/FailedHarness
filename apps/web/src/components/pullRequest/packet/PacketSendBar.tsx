import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { CheckIcon, GitBranchPlusIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { reviewCommentEnvironment } from "~/state/reviewComments";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import { usePacketComments } from "./PacketComments";
import { chooseSendTarget } from "./packetComments.logic";

export interface PacketCheckout {
  readonly allowed: boolean;
  readonly busy: boolean;
  readonly run: () => void;
}

interface SentNotice {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly delivery: "started" | "queued";
}

function ThreadLink({ threadId, title }: { threadId: ThreadId; title: string }) {
  const model = usePacketComments();
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: model.environmentId, threadId }}
      className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline"
    >
      {title}
    </Link>
  );
}

/**
 * Pinned under the packet while anything is unsent: how much, which thread it goes to, and the
 * one action that sends it all. Without an owning thread it offers the worktree checkout.
 */
export function PacketSendBar({ checkout }: { checkout: PacketCheckout | null }) {
  const gt = useGT();
  const resolve = useMessages();
  const model = usePacketComments();
  const { environmentId, change } = model;
  const unsent = model.counts.unsent;
  const [picked, setPicked] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<SentNotice | null>(null);
  const canSend = useAtomValue(reviewCommentEnvironment.send.permissionAtom(environmentId));
  const runSend = useAtomCommand(reviewCommentEnvironment.send, { reportFailure: false });
  const target = useEnvironmentQuery(
    unsent > 0 ? reviewCommentEnvironment.sendTarget({ environmentId, input: change }) : null,
    resolve,
  );
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const owners = threads
    .filter((thread) => thread.branch === change.branch)
    .map((thread) => `${thread.id}:${thread.archivedAt ?? ""}`)
    .join(",");
  const seenOwners = useRef(owners);
  const refreshTarget = target.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server decides which threads own the change; a thread joining or leaving the branch changes its answer
  useEffect(() => {
    if (seenOwners.current === owners) return;
    seenOwners.current = owners;
    refreshTarget();
  }, [owners, refreshTarget]);

  if (!model.canWrite || (unsent === 0 && notice === null)) return null;
  const candidates = target.data?.candidates ?? [];
  const chosen = chooseSendTarget(candidates, picked);

  const send = async () => {
    if (chosen === null || sending) return;
    setSending(true);
    const result = await runSend({
      environmentId,
      input: { ...change, threadId: chosen.threadId, source: "web" },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: m(msg("Could not send the comments")),
          description: formatEnvironmentQueryError(result.cause),
        });
      }
      return;
    }
    const sent = result.value;
    if (sent._tag === "sent") {
      model.markSent(sent.threadId);
      setNotice({
        threadId: sent.threadId,
        title: chosen.title,
        delivery: sent.delivery,
      });
    } else {
      refreshTarget();
    }
  };

  return (
    <div
      role="region"
      aria-label={gt("Unsent review comments")}
      className="sticky bottom-0 z-10 -mx-4 mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 bg-background/95 py-2 ps-4 pe-14 text-sm backdrop-blur-sm"
    >
      {unsent === 0 && notice !== null ? (
        <>
          <CheckIcon aria-hidden className="size-4 shrink-0 text-success-foreground" />
          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
            <T>
              Sent to <Var>{<ThreadLink threadId={notice.threadId} title={notice.title} />}</Var>
            </T>
            <span className="text-muted-foreground">
              {notice.delivery === "queued"
                ? gt("It will read them after its current turn.")
                : gt("It is reading them now.")}
            </span>
          </span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Dismiss")}
            onClick={() => setNotice(null)}
          >
            <XIcon aria-hidden />
          </Button>
        </>
      ) : (
        <>
          <span className="flex min-w-0 grow basis-full flex-wrap items-center gap-x-1.5 gap-y-1 sm:basis-0">
            <span className="font-medium">
              {gt(
                "{count, plural, one {{count} comment not sent} other {{count} comments not sent}}",
                { count: unsent },
              )}
            </span>
            {target.data === null ? (
              target.error === null ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Spinner />
                  {gt("Finding the thread that owns this change…")}
                </span>
              ) : (
                <span className="text-muted-foreground">{target.error}</span>
              )
            ) : chosen === null ? (
              <span className="text-muted-foreground">
                <T>
                  No thread works on <Var>{<code className="font-mono">{change.branch}</code>}</Var>{" "}
                  yet. Check it out in a worktree and start the thread it opens, then send here.
                </T>
              </span>
            ) : candidates.length > 1 ? (
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                {gt("Goes to", {
                  $context: "label before a picker of threads to send review comments to",
                })}
                <Select
                  value={chosen.threadId}
                  onValueChange={(value) => {
                    if (value !== null) setPicked(value);
                  }}
                >
                  <SelectTrigger
                    size="xs"
                    className="w-auto min-w-0 max-w-64"
                    aria-label={gt("Thread to send to")}
                  >
                    <span className="min-w-0 truncate">{chosen.title}</span>
                  </SelectTrigger>
                  <SelectPopup side="top" alignItemWithTrigger={false}>
                    {candidates.map((candidate) => (
                      <SelectItem key={candidate.threadId} value={candidate.threadId}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </span>
            ) : (
              <span className="flex min-w-0 items-baseline gap-1 text-muted-foreground">
                {gt("Goes to", {
                  $context: "label before the thread review comments will be sent to",
                })}
                <ThreadLink threadId={chosen.threadId} title={chosen.title} />
              </span>
            )}
          </span>
          <span className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            {target.data !== null && chosen === null && checkout !== null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!checkout.allowed || checkout.busy}
                onClick={checkout.run}
              >
                {checkout.busy ? <Spinner /> : <GitBranchPlusIcon aria-hidden />}
                {gt("Check out in a worktree")}
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!canSend || chosen === null || sending}
              onClick={() => void send()}
            >
              {sending ? <Spinner /> : <SendIcon aria-hidden />}
              {gt("Send to agent")}
            </Button>
          </span>
        </>
      )}
    </div>
  );
}
