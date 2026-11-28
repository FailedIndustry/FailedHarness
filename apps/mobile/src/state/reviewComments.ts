import { useAtomValue } from "@effect/atom-react";
import {
  changeCommentsKey,
  createReviewCommentEnvironmentAtoms,
  NO_CHANGE_COMMENTS,
  type ChangeCommentsView,
} from "@t3tools/client-runtime/state/review-comments";
import { EMPTY_OVERLAY, type CommentOverlay } from "@t3tools/client-runtime/review-packet-comments";
import { indexReviewPackets, type ReviewPacketIndex } from "@t3tools/shared/reviewQueue";
import {
  REVIEW_PACKET_LIST_MAX_LIMIT,
  type EnvironmentId,
  type ReviewPacketChangeRef,
  type ReviewPacketChangeSummary,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewCommentEnvironment = createReviewCommentEnvironmentAtoms(connectionAtomRuntime);

const NO_COMMENTS = Atom.make<ChangeCommentsView>(NO_CHANGE_COMMENTS);

export function useChangeComments(
  environmentId: EnvironmentId,
  change: ReviewPacketChangeRef | null,
): ChangeCommentsView {
  return useAtomValue(
    change === null
      ? NO_COMMENTS
      : reviewCommentEnvironment.changeComments(changeCommentsKey(environmentId, change)),
  );
}

/**
 * What the server answered to this device's own comment commands, by `changeCommentsKey`. The
 * composer is a sheet of its own, so the packet it returns to reads the answer from here.
 */
export const reviewCommentOverlayFamily = Atom.family((_key: string) =>
  Atom.make<CommentOverlay>(EMPTY_OVERLAY).pipe(Atom.setIdleTTL(5 * 60_000)),
);

/** Unsaved comment text by what it is for, kept when its sheet is dismissed; null when untouched. */
export const reviewCommentDraftFamily = Atom.family((_key: string) =>
  Atom.make<string | null>(null).pipe(Atom.setIdleTTL(30 * 60_000)),
);

type PacketIndexes = ReadonlyMap<EnvironmentId, ReviewPacketIndex<ReviewPacketChangeSummary>>;

// One `changeList` read per environment, refreshed by the review signal; never one per row.
const packetIndexesFamily = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get): PacketIndexes => {
    const indexes = new Map<EnvironmentId, ReviewPacketIndex<ReviewPacketChangeSummary>>();
    for (const environmentId of environmentIds) {
      const result = get(
        reviewCommentEnvironment.changeList({
          environmentId,
          input: { limit: REVIEW_PACKET_LIST_MAX_LIMIT },
        }),
      );
      const value = AsyncResult.getOrElse(result, () => null);
      if (value !== null) indexes.set(environmentId, indexReviewPackets(value.changes));
    }
    return indexes;
  }).pipe(Atom.withLabel(`mobile:review-packet-indexes:${key}`));
});

/** Every stored packet's summary per environment, newest recorded first. */
export function useReviewPacketIndexes(
  environmentIds: ReadonlyArray<EnvironmentId>,
): PacketIndexes {
  return useAtomValue(packetIndexesFamily(JSON.stringify([...environmentIds].sort())));
}
