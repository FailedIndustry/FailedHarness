import { useAtomValue } from "@effect/atom-react";
import { createReviewCommentEnvironmentAtoms } from "@t3tools/client-runtime/state/review-comments";
import {
  REVIEW_COMMENT_LIMITS,
  type EnvironmentId,
  type ReviewCommentCounts,
  type ReviewCommentListResult,
  type ReviewCommentThread,
  type ReviewPacketChangeRef,
  type ReviewRegion,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";

export const reviewCommentEnvironment = createReviewCommentEnvironmentAtoms(connectionAtomRuntime);

/** Pages a packet reads before it stops; one send delivers at most 50 comments anyway. */
const MAX_PAGES = 8;

export interface ChangeComments {
  readonly threads: ReadonlyArray<ReviewCommentThread>;
  readonly counts: ReviewCommentCounts;
  readonly latestHead: string | null;
  /** The oldest page's arrival on this client's clock. */
  readonly updatedAt: number;
  /** False when the change has more comments than this client reads. */
  readonly complete: boolean;
}

export interface ChangeCommentsView {
  readonly data: ChangeComments | null;
  readonly waiting: boolean;
  readonly failure: Cause.Cause<unknown> | null;
}

/** Every comment of a change, page after page, each page refreshing on the review signal. */
const changeCommentsAtom = Atom.family((key: string) =>
  Atom.make((get): ChangeCommentsView => {
    const { environmentId, change } = JSON.parse(key) as {
      readonly environmentId: EnvironmentId;
      readonly change: ReviewPacketChangeRef;
    };
    const threads: Array<ReviewCommentThread> = [];
    let first: { readonly counts: ReviewCommentCounts; readonly latestHead: string | null } | null =
      null;
    let updatedAt = Number.POSITIVE_INFINITY;
    let waiting = false;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result: AsyncResult.AsyncResult<ReviewCommentListResult, unknown> = get(
        reviewCommentEnvironment.comments({
          environmentId,
          input: {
            ...change,
            limit: REVIEW_COMMENT_LIMITS.pageSize,
            ...(cursor === null ? {} : { cursor }),
          },
        }),
      );
      waiting ||= result.waiting;
      const value: ReviewCommentListResult | null = AsyncResult.getOrElse(result, () => null);
      if (value === null) {
        return {
          data: null,
          waiting: true,
          failure: result._tag === "Failure" ? result.cause : null,
        };
      }
      if (result._tag === "Success") updatedAt = Math.min(updatedAt, result.timestamp);
      first ??= { counts: value.counts, latestHead: value.latestHead };
      threads.push(...value.comments);
      cursor = value.nextCursor;
      if (cursor === null) break;
    }
    return {
      data: {
        threads,
        counts: first!.counts,
        latestHead: first!.latestHead,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        complete: cursor === null,
      },
      waiting,
      failure: null,
    };
  }).pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`web-review-comments:${key}`)),
);

const NO_COMMENTS = Atom.make<ChangeCommentsView>({ data: null, waiting: false, failure: null });

export function useChangeComments(
  environmentId: EnvironmentId,
  change: ReviewPacketChangeRef | null,
): ChangeCommentsView {
  return useAtomValue(
    change === null
      ? NO_COMMENTS
      : changeCommentsAtom(
          JSON.stringify({
            environmentId,
            change: { host: change.host, repository: change.repository, branch: change.branch },
          }),
        ),
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
