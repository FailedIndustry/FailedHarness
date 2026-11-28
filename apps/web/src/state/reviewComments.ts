import { useAtomValue } from "@effect/atom-react";
import {
  changeCommentsKey,
  createReviewCommentEnvironmentAtoms,
  NO_CHANGE_COMMENTS,
  type ChangeCommentsView,
} from "@t3tools/client-runtime/state/review-comments";
import { indexReviewPackets, type ReviewPacketIndex } from "@t3tools/shared/reviewQueue";
import {
  REVIEW_PACKET_LIST_MAX_LIMIT,
  type EnvironmentId,
  type ReviewPacketChangeRef,
  type ReviewPacketChangeSummary,
  type ReviewRegion,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { createMergedEnvironmentQuery } from "./pullRequests";

export const reviewCommentEnvironment = createReviewCommentEnvironmentAtoms(connectionAtomRuntime);

export type {
  ChangeComments,
  ChangeCommentsView,
} from "@t3tools/client-runtime/state/review-comments";

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

const useChangeListsQuery = createMergedEnvironmentQuery(
  "web-review:change-lists",
  reviewCommentEnvironment.changeList,
);

/**
 * Every stored packet's summary per environment, from one `changeList` read each, which refreshes
 * itself on the review signal. The newest recorded changes come first, so a cap drops old ones.
 */
export function useReviewPacketIndexes(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, ReviewPacketIndex<ReviewPacketChangeSummary>> {
  const query = useChangeListsQuery(
    environmentIds.map((environmentId) => ({
      environmentId,
      input: { limit: REVIEW_PACKET_LIST_MAX_LIMIT },
    })),
  );
  return new Map(
    query.values.map(([environmentId, result]) => [
      environmentId,
      indexReviewPackets(result.changes),
    ]),
  );
}

/** What a new comment on a picture or clip will point at, before it has words. */
export interface ReviewCommentMark {
  readonly region: ReviewRegion | null;
  readonly range: { readonly startMs: number; readonly endMs: number } | null;
}

interface DraftStore {
  readonly drafts: Readonly<Record<string, string>>;
  readonly marks: Readonly<Record<string, ReviewCommentMark>>;
  readonly setDraft: (key: string, text: string) => void;
  readonly setMark: (key: string, mark: ReviewCommentMark) => void;
  readonly clearDraft: (key: string) => void;
}

const without = <V>(record: Readonly<Record<string, V>>, key: string) => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/**
 * What a reviewer is typing and marking, by what it is for. Kept outside the comments so a
 * refresh, a re-ordered list or a closed viewer never takes it away.
 */
export const useReviewCommentDrafts = create<DraftStore>()((set) => ({
  drafts: {},
  marks: {},
  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  setMark: (key, mark) => set((state) => ({ marks: { ...state.marks, [key]: mark } })),
  clearDraft: (key) =>
    set((state) =>
      key in state.drafts || key in state.marks
        ? { drafts: without(state.drafts, key), marks: without(state.marks, key) }
        : state,
    ),
}));
