import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { packetForPullRequest } from "@t3tools/client-runtime/review-packet";
import {
  applyOverlay,
  commentCounts,
  layoutPacketComments,
  overlayChange,
} from "@t3tools/client-runtime/review-packet-comments";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeCommentsKey } from "@t3tools/client-runtime/state/review-comments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type ReviewCommentAnchorInput,
  type ReviewCommentMutationResult,
  type ReviewPacket,
  type ReviewPacketChangeRef,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, useMessages } from "gt-react-native";
import { use } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { m } from "../../../i18n/messages";
import { composerPullRequests } from "../../../state/pull-requests";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../../state/query";
import {
  reviewCommentEnvironment,
  reviewCommentOverlayFamily,
  useChangeComments,
} from "../../../state/reviewComments";
import { useAtomCommand } from "../../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "../usePullRequestDiff";

/** The change a packet is stored under, as a route can carry it. */
export type PacketChangeParams = {
  readonly environmentId: string;
  readonly host: string | null;
  readonly repository: string;
  readonly branch: string;
};

export const packetChangeRef = (params: PacketChangeParams): ReviewPacketChangeRef => ({
  host: params.host,
  repository: params.repository,
  branch: params.branch,
});

/**
 * The packet the server keeps for this pull request's branch, if any. Like review guides, a
 * packet is not routed: each server keeps the packets it was given.
 */
export function usePullRequestPacket(params: PullRequestParams) {
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const source = detail.data ?? params.initialSummary ?? null;
  const host =
    params.host ??
    (source === null
      ? undefined
      : sourceControlClients.parseChangeRequestUrl(source.url)?.link.host);
  const change: PacketChangeParams | null =
    source === null || host === undefined
      ? null
      : {
          environmentId: params.environmentId,
          host,
          repository: source.repository,
          branch: source.headBranch,
        };
  const query = useEnvironmentQuery(
    change === null
      ? null
      : composerPullRequests.reviewPacket({
          environmentId: target.environmentId,
          input: packetChangeRef(change),
        }),
  );
  const packet = packetForPullRequest(query.data?.packet ?? null, params.number);
  return {
    change: packet === null ? null : change,
    packet,
    headSha: detail.data?.headSha,
    refresh: query.refresh,
  };
}

/**
 * Every way this device changes a change's comments. Each answer is laid over the comments
 * until the comments query catches up, so a sheet that saved one returns to it shown.
 */
export function useReviewCommentActions(change: PacketChangeParams) {
  const registry = use(RegistryContext);
  const environmentId = EnvironmentId.make(change.environmentId);
  const ref = packetChangeRef(change);
  const overlayAtom = reviewCommentOverlayFamily(changeCommentsKey(environmentId, ref));
  const options = { reportFailure: false } as const;
  const runCreate = useAtomCommand(reviewCommentEnvironment.create, options);
  const runEdit = useAtomCommand(reviewCommentEnvironment.edit, options);
  const runRemove = useAtomCommand(reviewCommentEnvironment.remove, options);
  const runReply = useAtomCommand(reviewCommentEnvironment.reply, options);
  const runSetResolved = useAtomCommand(reviewCommentEnvironment.setResolved, options);

  const settle = async <E>(
    run: Promise<AtomCommandResult<ReviewCommentMutationResult, E>>,
    commentId: string | null,
    failure: string,
  ) => {
    const result = await run;
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) Dialog.alert(failure, failureMessage(result));
      return false;
    }
    const comment = result.value.comment;
    const id = comment?.id ?? commentId;
    if (id !== null) {
      registry.set(overlayAtom, overlayChange(registry.get(overlayAtom), id, comment, Date.now()));
    }
    return true;
  };

  return {
    create: (anchor: ReviewCommentAnchorInput, text: string) =>
      settle(
        runCreate({ environmentId, input: { ...ref, anchor, text } }),
        null,
        m(msg("Could not save the comment")),
      ),
    edit: (commentId: string, entryId: string, text: string) =>
      settle(
        runEdit({ environmentId, input: { commentId, entryId, text } }),
        commentId,
        m(msg("Could not save the comment")),
      ),
    remove: (commentId: string, entryId: string) =>
      settle(
        runRemove({ environmentId, input: { commentId, entryId } }),
        commentId,
        m(msg("Could not delete the comment")),
      ),
    reply: (commentId: string, text: string) =>
      settle(
        runReply({ environmentId, input: { commentId, text } }),
        commentId,
        m(msg("Could not save the reply")),
      ),
    setResolved: (commentId: string, resolved: boolean) =>
      settle(
        runSetResolved({ environmentId, input: { commentId, resolved } }),
        commentId,
        resolved ? m(msg("Could not resolve the comment")) : m(msg("Could not reopen the comment")),
      ),
    markSent: (threadId: ThreadId) => {
      const now = Date.now();
      registry.set(overlayAtom, {
        ...registry.get(overlayAtom),
        sent: { threadId, at: new Date(now).toISOString(), atMs: now },
      });
    },
  };
}

export function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error
    ? (errorDisplayMessage(cause, m) ?? cause.message)
    : m(msg("An error occurred."));
}

/** The comments of the change whose packet is on screen, placed on it. */
export function usePacketComments(change: PacketChangeParams, packet: ReviewPacket) {
  const resolve = useMessages();
  const environmentId = EnvironmentId.make(change.environmentId);
  const ref = packetChangeRef(change);
  const view = useChangeComments(environmentId, ref);
  const overlay = useAtomValue(reviewCommentOverlayFamily(changeCommentsKey(environmentId, ref)));
  const canWrite = useAtomValue(reviewCommentEnvironment.create.permissionAtom(environmentId));
  const data = view.data;
  const threads = data === null ? [] : applyOverlay(data.threads, overlay, data.updatedAt);
  const counts =
    data === null ? commentCounts([]) : data.complete ? commentCounts(threads) : data.counts;
  return {
    canWrite,
    loaded: data !== null,
    error: view.failure === null ? null : formatEnvironmentQueryError(view.failure, resolve),
    threads,
    layout: layoutPacketComments(threads, packet),
    counts,
  };
}

export type PacketCommentsModel = ReturnType<typeof usePacketComments>;
