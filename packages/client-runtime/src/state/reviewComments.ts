import {
  REVIEW_COMMENT_LIMITS,
  WS_METHODS,
  isUnknownUnionMember,
  type EnvironmentId,
  type ReviewCommentCounts,
  type ReviewCommentListResult,
  type ReviewCommentThread,
  type ReviewPacketChangeRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

function makeReviewChangesAtomFamily<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:review:changes",
    tag: WS_METHODS.reviewPacketsSubscribeChanges,
  });
}

const changeFamiliesByRuntime = new WeakMap<
  object,
  ReturnType<typeof makeReviewChangesAtomFamily>
>();

/**
 * One subscription per environment that ticks whenever a review packet or comment there changes,
 * an agent's answer included. Queries refresh on it only while something reads them.
 */
export function reviewChangesAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
): ReturnType<typeof makeReviewChangesAtomFamily<R, E>> {
  const existing = changeFamiliesByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makeReviewChangesAtomFamily<R, E>>;
  const family = makeReviewChangesAtomFamily(runtime);
  changeFamiliesByRuntime.set(runtime, family);
  return family;
}

/**
 * @public The review UI in web and mobile calls these.
 *
 * Review comments on a change's packet, per environment. Every mutation is a person's; the
 * server derives each comment's state and tells every client through `changes`, so no command
 * here patches or refreshes a query itself.
 */
export function createReviewCommentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const changes = reviewChangesAtomFamily(runtime);
  const scheduler = createAtomCommandScheduler();
  // One environment's comments change one at a time on the server; keep a client's in order too.
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const comments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:review:comments",
    tag: WS_METHODS.reviewCommentsList,
    refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
  });
  return {
    changes,
    /** A change's comment threads in creation order, with state, `outdated` and counts. */
    comments,
    /** Every comment of a change, page after page; key it with `changeCommentsKey`. */
    changeComments: Atom.family((key: string) =>
      Atom.make((get) => readChangeComments(key, (input) => get(comments(input)))).pipe(
        Atom.setIdleTTL(60_000),
        Atom.withLabel(`environment-data:review:change-comments:${key}`),
      ),
    ),
    /** Changes with stored packets, each with its comment counts by state. */
    changeList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:change-list",
      tag: WS_METHODS.reviewPacketsList,
      refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
    }),
    /** `git diff base head -- paths` for one stored packet revision; commits never change. */
    recordedDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:recorded-diff",
      tag: WS_METHODS.reviewPacketsRecordedDiff,
      staleTimeMs: Number.POSITIVE_INFINITY,
    }),
    /** The threads a send would go to, resolved by the server as the send resolves them. */
    sendTarget: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:send-target",
      tag: WS_METHODS.reviewCommentsSendTarget,
      refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:create",
      tag: WS_METHODS.reviewCommentsCreate,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    edit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:edit",
      tag: WS_METHODS.reviewCommentsEdit,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:delete",
      tag: WS_METHODS.reviewCommentsDelete,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    reply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:reply",
      tag: WS_METHODS.reviewCommentsReply,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    setResolved: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:set-resolved",
      tag: WS_METHODS.reviewCommentsSetResolved,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:send",
      tag: WS_METHODS.reviewCommentsSend,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}

/** Pages a packet reads before it stops; one send delivers at most 50 comments anyway. */
const MAX_COMMENT_PAGES = 8;

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

export const NO_CHANGE_COMMENTS: ChangeCommentsView = { data: null, waiting: false, failure: null };

/** The `changeComments` key of a change; only the change's own fields count. */
export const changeCommentsKey = (environmentId: EnvironmentId, change: ReviewPacketChangeRef) =>
  JSON.stringify({
    environmentId,
    change: { host: change.host, repository: change.repository, branch: change.branch },
  });

function readChangeComments(
  key: string,
  read: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: ReviewPacketChangeRef & { readonly limit: number; readonly cursor?: string };
  }) => AsyncResult.AsyncResult<ReviewCommentListResult, unknown>,
): ChangeCommentsView {
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
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const result = read({
      environmentId,
      input: {
        ...change,
        limit: REVIEW_COMMENT_LIMITS.pageSize,
        ...(cursor === null ? {} : { cursor }),
      },
    });
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
}

export interface ReviewCommentIndex {
  /** By claim id: claim comments, and comments written under that claim. */
  readonly byClaim: ReadonlyMap<string, ReadonlyArray<ReviewCommentThread>>;
  /**
   * By media hash in the latest packet: image regions, and video ranges by the clip that holds
   * them now, which is another clip when the recording was cut again.
   */
  readonly byMedia: ReadonlyMap<string, ReadonlyArray<ReviewCommentThread>>;
  /** By file path, for code ranges. */
  readonly byPath: ReadonlyMap<string, ReadonlyArray<ReviewCommentThread>>;
  /** Comments whose anchor the latest packet no longer has; they belong in a list of their own. */
  readonly outdated: ReadonlyArray<ReviewCommentThread>;
  /** Anchors of a kind this client does not know. */
  readonly unknown: ReadonlyArray<ReviewCommentThread>;
}

/** Where each comment shows on the packet a client draws. */
export function indexReviewComments(
  threads: ReadonlyArray<ReviewCommentThread>,
): ReviewCommentIndex {
  const byClaim = new Map<string, Array<ReviewCommentThread>>();
  const byMedia = new Map<string, Array<ReviewCommentThread>>();
  const byPath = new Map<string, Array<ReviewCommentThread>>();
  const outdated: Array<ReviewCommentThread> = [];
  const unknown: Array<ReviewCommentThread> = [];
  const add = (
    map: Map<string, Array<ReviewCommentThread>>,
    key: string,
    thread: ReviewCommentThread,
  ) => map.set(key, [...(map.get(key) ?? []), thread]);
  for (const thread of threads) {
    const anchor = thread.anchor;
    if (isUnknownUnionMember(anchor)) {
      unknown.push(thread);
      continue;
    }
    if (thread.outdated) {
      outdated.push(thread);
      continue;
    }
    if (anchor.claimId !== undefined) add(byClaim, anchor.claimId, thread);
    switch (anchor.kind) {
      case "claim":
        break;
      case "image-region":
        add(byMedia, anchor.media, thread);
        break;
      case "video-range":
        add(byMedia, thread.currentClip?.media ?? anchor.media, thread);
        break;
      case "code-range":
        add(byPath, anchor.path, thread);
        break;
    }
  }
  return { byClaim, byMedia, byPath, outdated, unknown };
}
