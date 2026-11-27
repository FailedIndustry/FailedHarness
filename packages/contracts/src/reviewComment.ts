import * as Schema from "effect/Schema";

import {
  ForwardCompatibleUnion,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ReviewClaimId,
  ReviewCommentCounts,
  ReviewCommitSha,
  ReviewMediaId,
  ReviewPacketChangeRef,
  ReviewTimestamp,
  type ReviewEvidence,
  type ReviewPacket,
} from "./reviewPacket.ts";

/**
 * Review comments a person attaches to a change's review packet, answered by the agent that owns
 * the change. The server stores them by change, derives each one's state, and keeps them until a
 * person deletes or resolves them; a comment whose anchor left the latest packet is flagged
 * `outdated`, never dropped.
 */

export const REVIEW_COMMENT_LIMITS = {
  textChars: 4000,
  entriesPerComment: 20,
  /** Comments and follow-ups waiting to be sent, per change; one send delivers them all. */
  unsentPerChange: 50,
  pageSize: 50,
  diffPaths: 100,
} as const;

const fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** A rectangle as fractions of the image or frame: `x` and `width` of its width, `y` and `height` of its height. */
export const ReviewRegion = Schema.Struct({
  x: fraction,
  y: fraction,
  width: fraction,
  height: fraction,
}).check(
  Schema.makeFilter(
    (region) =>
      (region.width > 0 &&
        region.height > 0 &&
        region.x + region.width <= 1 + 1e-9 &&
        region.y + region.height <= 1 + 1e-9) ||
      "A region has a size and stays inside the picture.",
  ),
);
export type ReviewRegion = typeof ReviewRegion.Type;

const anchorBase = {
  /** The packet revision the comment was written against. */
  packetHead: ReviewCommitSha,
  /** The claim the comment was written under, when it was. */
  claimId: Schema.optionalKey(ReviewClaimId),
};

const MillisecondRange = { startMs: NonNegativeInt, endMs: NonNegativeInt };
const orderedRange = <A extends { readonly startMs: number; readonly endMs: number }>(range: A) =>
  range.endMs >= range.startMs || "A range ends at or after it starts.";

export const ReviewCodeRangeAnchor = Schema.Struct({
  kind: Schema.Literal("code-range"),
  ...anchorBase,
  path: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  side: Schema.Literals(["old", "new"]),
  startLine: PositiveInt,
  endLine: PositiveInt,
  /** The commit whose file the lines are in. */
  commit: ReviewCommitSha,
}).check(
  Schema.makeFilter(
    (anchor) => anchor.endLine >= anchor.startLine || "A line range ends at or after it starts.",
  ),
);

export const ReviewClaimAnchor = Schema.Struct({
  kind: Schema.Literal("claim"),
  packetHead: ReviewCommitSha,
  claimId: ReviewClaimId,
});

export const ReviewImageRegionAnchor = Schema.Struct({
  kind: Schema.Literal("image-region"),
  ...anchorBase,
  media: ReviewMediaId,
  /** Absent: the whole image. */
  region: Schema.optionalKey(ReviewRegion),
});

export const ReviewVideoRangeAnchor = Schema.Struct({
  kind: Schema.Literal("video-range"),
  ...anchorBase,
  /** The clip file; the range is in clip time. */
  media: ReviewMediaId,
  ...MillisecondRange,
  /**
   * The same range in the full recording the clip was cut from, so it can be found again in a
   * later clip. The server fills it in from the clip's evidence; a value a client sends is replaced.
   */
  recording: Schema.optionalKey(
    Schema.Struct({ media: ReviewMediaId, ...MillisecondRange }).check(
      Schema.makeFilter(orderedRange),
    ),
  ),
  region: Schema.optionalKey(ReviewRegion),
}).check(Schema.makeFilter(orderedRange));

const knownAnchors = [
  ReviewCodeRangeAnchor,
  ReviewClaimAnchor,
  ReviewImageRegionAnchor,
  ReviewVideoRangeAnchor,
] as const;

/** What a client may anchor a new comment to. */
export const ReviewCommentAnchorInput = Schema.Union(knownAnchors);
export type ReviewCommentAnchorInput = typeof ReviewCommentAnchorInput.Type;

/** A kind this reader does not know decodes to an `UnknownUnionMember`; see `isUnknownUnionMember`. */
export const ReviewCommentAnchor = ForwardCompatibleUnion(knownAnchors, "kind");
export type ReviewCommentAnchor = typeof ReviewCommentAnchor.Type;

/**
 * `pending`: written, not yet sent to the agent. `open`: sent, and the last word is a person's.
 * `answered`: the last word is the agent's. `resolved`: a person resolved it.
 */
export const ReviewCommentState = Schema.Literals(["pending", "open", "answered", "resolved"]);
export type ReviewCommentState = typeof ReviewCommentState.Type;

export const ReviewCommentAnswerKind = Schema.Literals(["fixed", "answered", "disagrees"]);
export type ReviewCommentAnswerKind = typeof ReviewCommentAnswerKind.Type;

export const ReviewCommentId = Schema.String.check(Schema.isPattern(/^rc_[0-9a-f]{16}$/u));
export const ReviewCommentEntryId = Schema.String.check(Schema.isPattern(/^re_[0-9a-f]{16}$/u));
const CommentText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(REVIEW_COMMENT_LIMITS.textChars),
);
/** A commit as the agent names it, abbreviated or whole. */
export const ReviewFixCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/u));

export const ReviewCommentPersonEntry = Schema.Struct({
  id: ReviewCommentEntryId,
  author: Schema.Literal("person"),
  text: Schema.String,
  createdAt: ReviewTimestamp,
  updatedAt: ReviewTimestamp,
  /** Null until a send delivers it; only unsent entries can be edited or deleted. */
  sentAt: Schema.NullOr(ReviewTimestamp),
  sentToThreadId: Schema.NullOr(ThreadId),
});

export const ReviewCommentAgentEntry = Schema.Struct({
  id: ReviewCommentEntryId,
  author: Schema.Literal("agent"),
  kind: ReviewCommentAnswerKind,
  text: Schema.String,
  /** For `fixed`: the commit the fix is in. */
  fixedIn: Schema.optionalKey(ReviewFixCommit),
  /** The thread whose agent answered. */
  threadId: Schema.NullOr(ThreadId),
  createdAt: ReviewTimestamp,
});

export const ReviewCommentEntry = Schema.Union([ReviewCommentPersonEntry, ReviewCommentAgentEntry]);
export type ReviewCommentEntry = typeof ReviewCommentEntry.Type;

/** Where a `video-range` comment's range is in the latest packet: its own clip, or a re-cut one. */
export const ReviewVideoRangeLocation = Schema.Struct({
  media: ReviewMediaId,
  evidenceId: Schema.String,
  ...MillisecondRange,
});
export type ReviewVideoRangeLocation = typeof ReviewVideoRangeLocation.Type;

export const ReviewCommentThread = Schema.Struct({
  id: ReviewCommentId,
  anchor: ReviewCommentAnchor,
  state: ReviewCommentState,
  /** The anchor no longer exists in the change's latest packet. */
  outdated: Schema.Boolean,
  /** For `video-range`, when the latest packet still has the range. */
  currentClip: Schema.optionalKey(ReviewVideoRangeLocation),
  /** The root entry first, then replies in order. */
  entries: Schema.Array(ReviewCommentEntry),
  createdAt: ReviewTimestamp,
  updatedAt: ReviewTimestamp,
  resolvedAt: Schema.NullOr(ReviewTimestamp),
});
export type ReviewCommentThread = typeof ReviewCommentThread.Type;

/** A change's comments, oldest first. */
export const ReviewCommentListInput = Schema.Struct({
  ...ReviewPacketChangeRef.fields,
  states: Schema.optionalKey(Schema.Array(ReviewCommentState).check(Schema.isMaxLength(4))),
  /** `nextCursor` of the previous page. */
  cursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(REVIEW_COMMENT_LIMITS.pageSize)),
  ),
});
export type ReviewCommentListInput = typeof ReviewCommentListInput.Type;

export const ReviewCommentListResult = Schema.Struct({
  comments: Schema.Array(ReviewCommentThread),
  nextCursor: Schema.NullOr(Schema.String),
  /** Every comment of the change, not just this page. */
  counts: ReviewCommentCounts,
  /** The latest packet `outdated` was computed against; null when the change has none. */
  latestHead: Schema.NullOr(ReviewCommitSha),
});
export type ReviewCommentListResult = typeof ReviewCommentListResult.Type;

export const ReviewCommentCreateInput = Schema.Struct({
  ...ReviewPacketChangeRef.fields,
  anchor: ReviewCommentAnchorInput,
  text: CommentText,
});
export type ReviewCommentCreateInput = typeof ReviewCommentCreateInput.Type;

export const ReviewCommentEditInput = Schema.Struct({
  commentId: ReviewCommentId,
  entryId: ReviewCommentEntryId,
  text: CommentText,
});
export type ReviewCommentEditInput = typeof ReviewCommentEditInput.Type;

/** Deleting a comment's unsent root deletes the comment. */
export const ReviewCommentDeleteInput = Schema.Struct({
  commentId: ReviewCommentId,
  entryId: ReviewCommentEntryId,
});
export type ReviewCommentDeleteInput = typeof ReviewCommentDeleteInput.Type;

/** A person's follow-up; it reopens a resolved comment and waits for the next send. */
export const ReviewCommentReplyInput = Schema.Struct({
  commentId: ReviewCommentId,
  text: CommentText,
});
export type ReviewCommentReplyInput = typeof ReviewCommentReplyInput.Type;

export const ReviewCommentSetResolvedInput = Schema.Struct({
  commentId: ReviewCommentId,
  resolved: Schema.Boolean,
});
export type ReviewCommentSetResolvedInput = typeof ReviewCommentSetResolvedInput.Type;

/** The comment after the change; null when a delete removed it. */
export const ReviewCommentMutationResult = Schema.Struct({
  comment: Schema.NullOr(ReviewCommentThread),
});
export type ReviewCommentMutationResult = typeof ReviewCommentMutationResult.Type;

/**
 * Sends every unsent comment and follow-up of the change to one thread, queued behind its running
 * turn. Without `threadId`, the server picks the thread that owns the change.
 */
export const ReviewCommentSendInput = Schema.Struct({
  ...ReviewPacketChangeRef.fields,
  threadId: Schema.optionalKey(ThreadId),
  /** The client sending, as on a message. Default: web. */
  source: Schema.optionalKey(Schema.Literals(["web", "mobile"])),
});
export type ReviewCommentSendInput = typeof ReviewCommentSendInput.Type;

export const ReviewCommentThreadCandidate = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  /** How it owns the change: its checkout is on the branch, or it links the pull request. */
  match: Schema.Literals(["branch", "pull-request"]),
});
export type ReviewCommentThreadCandidate = typeof ReviewCommentThreadCandidate.Type;

export const ReviewCommentSendResult = Schema.Union([
  Schema.TaggedStruct("sent", {
    threadId: ThreadId,
    messageId: TrimmedNonEmptyString,
    comments: PositiveInt,
    entries: PositiveInt,
    /** `queued` behind a running turn, or `started` on an idle thread. */
    delivery: Schema.Literals(["started", "queued"]),
    /** Every thread that owns the change, most recently active first, when more than one does. */
    candidates: Schema.Array(ReviewCommentThreadCandidate),
  }),
  Schema.TaggedStruct("nothing-to-send", {}),
  /** No thread is on the branch or links the pull request; check the branch out in one first. */
  Schema.TaggedStruct("no-owning-thread", {
    pullRequest: Schema.NullOr(PositiveInt),
  }),
]);
export type ReviewCommentSendResult = typeof ReviewCommentSendResult.Type;

/** `git diff <base> <head> -- <paths>` for one stored packet revision, in the project's checkout. */
export const ReviewPacketRecordedDiffInput = Schema.Struct({
  ...ReviewPacketChangeRef.fields,
  head: ReviewCommitSha,
  paths: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(REVIEW_COMMENT_LIMITS.diffPaths),
  ),
});
export type ReviewPacketRecordedDiffInput = typeof ReviewPacketRecordedDiffInput.Type;

export const ReviewPacketRecordedDiffResult = Schema.Union([
  Schema.TaggedStruct("available", {
    base: ReviewCommitSha,
    head: ReviewCommitSha,
    /** A unified diff with `a/` and `b/` prefixes, as the pull request diff sends. */
    patch: Schema.String,
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("unavailable", {
    reason: Schema.Literals(["packet-not-found", "no-checkout", "commits-missing"]),
  }),
]);
export type ReviewPacketRecordedDiffResult = typeof ReviewPacketRecordedDiffResult.Type;

export class ReviewCommentRefusedError extends Schema.TaggedError<ReviewCommentRefusedError>()(
  "ReviewCommentRefusedError",
  {
    reason: Schema.Literals([
      "comment-not-found",
      "entry-not-found",
      "packet-not-found",
      "anchor-not-in-packet",
      "entry-sent",
      "not-sent-yet",
      "resolve-unsent",
      "pending",
      "resolved",
      "not-this-thread",
      "thread-not-found",
      "too-many-unsent",
      "too-many-entries",
      "fixed-needs-commit",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "comment-not-found":
        return "No review comment has that id.";
      case "entry-not-found":
        return "That review comment has no entry with that id.";
      case "packet-not-found":
        return "No stored review packet of this change has that head.";
      case "anchor-not-in-packet":
        return "That packet has no such claim, media or clip.";
      case "entry-sent":
        return "That entry was already sent to the agent, so it can no longer be edited or deleted.";
      case "not-sent-yet":
        return "This comment has not been sent yet. Edit it instead of replying.";
      case "resolve-unsent":
        return "This comment has not been sent. Delete it instead of resolving it.";
      case "pending":
        return "This comment has not been sent to the agent yet, so it cannot be answered.";
      case "resolved":
        return "A person resolved this comment. It needs no answer.";
      case "not-this-thread":
        return "This comment is on a change this thread does not own.";
      case "thread-not-found":
        return "That thread does not exist or is archived.";
      case "too-many-unsent":
        return `This change already has ${REVIEW_COMMENT_LIMITS.unsentPerChange} comments and follow-ups waiting. Send them first.`;
      case "too-many-entries":
        return `A review comment holds at most ${REVIEW_COMMENT_LIMITS.entriesPerComment} entries.`;
      case "fixed-needs-commit":
        return "A `fixed` answer names the commit the fix is in.";
    }
  }
}

export class ReviewCommentStoreError extends Schema.TaggedError<ReviewCommentStoreError>()(
  "ReviewCommentStoreError",
  {
    operation: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not read or store the review comments.";
  }
}

export class ReviewCommentSendError extends Schema.TaggedError<ReviewCommentSendError>()(
  "ReviewCommentSendError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not send the review comments to the thread. Nothing was marked as sent.";
  }
}

const clipsOf = (packet: ReviewPacket) => {
  const clips: Array<Extract<ReviewEvidence, { readonly kind: "clip" }>> = [];
  const visit = (evidence: ReadonlyArray<ReviewEvidence>) => {
    for (const item of evidence) if (item.kind === "clip") clips.push(item);
  };
  for (const claim of packet.claims) visit(claim.evidence);
  for (const finding of [...packet.blockers, ...packet.notes]) visit(finding.evidence ?? []);
  return clips;
};

/**
 * Where a video range is in `packet`: in the same clip, or in any clip cut from the same
 * recording that covers the whole range. Packet clips are real time, so clip time is recording
 * time minus the clip's `startMs`. Null when the packet no longer has it.
 */
export const locateVideoRange = (
  packet: ReviewPacket,
  anchor: Pick<typeof ReviewVideoRangeAnchor.Type, "media" | "startMs" | "endMs" | "recording">,
): ReviewVideoRangeLocation | null => {
  const clips = clipsOf(packet);
  const same = clips.find((clip) => clip.media === anchor.media);
  if (same !== undefined) {
    return { media: same.media, evidenceId: same.id, startMs: anchor.startMs, endMs: anchor.endMs };
  }
  const recording = anchor.recording;
  if (recording === undefined) return null;
  const recut = clips.find(
    (clip) =>
      clip.recording === recording.media &&
      clip.startMs <= recording.startMs &&
      recording.endMs <= clip.endMs,
  );
  return recut === undefined
    ? null
    : {
        media: recut.media,
        evidenceId: recut.id,
        startMs: recording.startMs - recut.startMs,
        endMs: recording.endMs - recut.startMs,
      };
};

/** The clip evidence of `packet` whose file is `media`, for a new `video-range` comment. */
export const findClipEvidence = (packet: ReviewPacket, media: string) =>
  clipsOf(packet).find((clip) => clip.media === media);
