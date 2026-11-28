import { WS_METHODS, isUnknownUnionMember, type ReviewCommentThread } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

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
  return {
    changes,
    /** A change's comment threads in creation order, with state, `outdated` and counts. */
    comments: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:comments",
      tag: WS_METHODS.reviewCommentsList,
      refreshTrigger: ({ environmentId }) => changes({ environmentId, input: {} }),
    }),
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
