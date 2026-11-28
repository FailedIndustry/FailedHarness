import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Version 1 of the review packet a project's harness assembles and the claims file the
 * implementing agent writes. Published JSON Schemas: `packages/contracts/schemas`.
 * Rules a JSON Schema cannot express: a clip's `endMs` is at least its `startMs`, and every
 * evidence `media` names an entry of `media[]` (see `findDanglingMediaReferences`).
 */

const REVIEW_PACKET_SCHEMA_VERSION = 1;

export const ReviewClaimId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u));
const ClaimId = ReviewClaimId;
export const ReviewCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const CommitSha = ReviewCommitSha;
export const ReviewMediaId = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
export const ReviewTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u),
);
const UtcTimestamp = ReviewTimestamp;
const Pathspecs = Schema.Array(Schema.String);

export const ReviewClaimsFile = Schema.Struct({
  summary: Schema.optionalKey(Schema.String),
  claims: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(ClaimId),
      title: Schema.NonEmptyString,
      statement: Schema.NonEmptyString,
      paths: Schema.optionalKey(Pathspecs),
    }),
  ),
});
export type ReviewClaimsFile = typeof ReviewClaimsFile.Type;

const ImageEvidence = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("image"),
  media: ReviewMediaId,
  caption: Schema.optionalKey(Schema.String),
});

const ClipEvidence = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("clip"),
  media: ReviewMediaId,
  recording: Schema.optionalKey(ReviewMediaId),
  startMs: NonNegativeInt,
  endMs: NonNegativeInt,
}).check(Schema.makeFilter((clip) => clip.endMs >= clip.startMs));

const CheckEvidence = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("check"),
  name: Schema.String,
  passed: Schema.Boolean,
});

const KnownEvidence = Schema.Union([ImageEvidence, ClipEvidence, CheckEvidence]);
export type ReviewEvidence = typeof KnownEvidence.Type;

const MediaEntry = Schema.Struct({
  id: ReviewMediaId,
  file: Schema.String,
  type: Schema.String,
  bytes: NonNegativeInt,
  width: Schema.optionalKey(NonNegativeInt),
  height: Schema.optionalKey(NonNegativeInt),
  durationMs: Schema.optionalKey(NonNegativeInt),
});

const ReviewPacketVerdict = Schema.Literals(["pass", "fail", "blocked"]);

const makePacket = <EvidenceList extends Schema.Top>(evidence: EvidenceList) => {
  const finding = Schema.Struct({ text: Schema.String, evidence: Schema.optionalKey(evidence) });
  return Schema.Struct({
    schema: Schema.Literal(REVIEW_PACKET_SCHEMA_VERSION),
    change: Schema.Struct({
      repository: Schema.String,
      branch: Schema.String,
      base: Schema.String,
      pullRequest: Schema.optionalKey(NonNegativeInt),
    }),
    revision: Schema.Struct({ base: CommitSha, head: CommitSha, recordedAt: UtcTimestamp }),
    summary: Schema.optionalKey(Schema.String),
    status: Schema.Struct({
      verdict: ReviewPacketVerdict,
      checks: Schema.optionalKey(
        Schema.Struct({
          passed: NonNegativeInt,
          newFailures: NonNegativeInt,
          knownFailures: Schema.optionalKey(NonNegativeInt),
        }),
      ),
      playtest: Schema.optionalKey(
        Schema.Struct({
          by: Schema.Literals(["agent", "person"]),
          model: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
    claims: Schema.Array(
      Schema.Struct({
        id: ClaimId,
        title: Schema.NonEmptyString,
        statement: Schema.NonEmptyString,
        result: Schema.Literals(["seen", "not-seen", "untested"]),
        observed: Schema.optionalKey(Schema.String),
        evidence,
        paths: Pathspecs,
      }),
    ),
    blockers: Schema.Array(finding),
    notes: Schema.Array(finding),
    media: Schema.Array(MediaEntry),
  });
};

/** Evidence of a kind this reader does not know is dropped on its own; the packet still decodes. */
export const ReviewPacket = makePacket(ForwardCompatibleArray(KnownEvidence));
export type ReviewPacket = typeof ReviewPacket.Type;

/** What a harness must emit today; the published JSON Schema comes from this, not the lenient reader. */
export const ReviewPacketStrict = makePacket(Schema.Array(KnownEvidence));

/** Media ids that evidence points at but `media[]` does not list. A clip's `recording` may dangle by design. */
export const findDanglingMediaReferences = (packet: ReviewPacket): ReadonlyArray<string> => {
  const listed = new Set(packet.media.map((entry) => entry.id));
  const dangling = new Set<string>();
  const visit = (evidence: ReadonlyArray<ReviewEvidence>) => {
    for (const item of evidence) {
      if ((item.kind === "image" || item.kind === "clip") && !listed.has(item.media)) {
        dangling.add(item.media);
      }
    }
  };
  for (const claim of packet.claims) visit(claim.evidence);
  for (const finding of [...packet.blockers, ...packet.notes]) visit(finding.evidence ?? []);
  return [...dangling];
};

/**
 * A change as the server stores it: a branch of a repository on a forge. `repository` is the
 * lowercased `owner/name`; `host` is null when intake could not tell which forge it lives on.
 */
export const ReviewPacketChangeRef = Schema.Struct({
  host: Schema.NullOr(TrimmedNonEmptyString),
  repository: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type ReviewPacketChangeRef = typeof ReviewPacketChangeRef.Type;

export const ReviewPacketRevisionSummary = Schema.Struct({
  head: CommitSha,
  base: CommitSha,
  recordedAt: UtcTimestamp,
  verdict: ReviewPacketVerdict,
});
export type ReviewPacketRevisionSummary = typeof ReviewPacketRevisionSummary.Type;

/**
 * A change's review comments by state; `unsent` counts the comments and follow-ups a send would
 * deliver. Older servers omit it from summaries.
 */
export const ReviewCommentCounts = Schema.Struct({
  pending: NonNegativeInt,
  open: NonNegativeInt,
  answered: NonNegativeInt,
  resolved: NonNegativeInt,
  unsent: NonNegativeInt,
});
export type ReviewCommentCounts = typeof ReviewCommentCounts.Type;

/** A change's latest stored revision, without its manifest. */
export const ReviewPacketChangeSummary = Schema.Struct({
  ...ReviewPacketChangeRef.fields,
  pullRequest: Schema.NullOr(NonNegativeInt),
  ...ReviewPacketRevisionSummary.fields,
  claims: Schema.Struct({
    seen: NonNegativeInt,
    notSeen: NonNegativeInt,
    untested: NonNegativeInt,
  }),
  blockers: NonNegativeInt,
  /** Set by `reviewPackets.list`. */
  comments: Schema.optionalKey(ReviewCommentCounts),
});
export type ReviewPacketChangeSummary = typeof ReviewPacketChangeSummary.Type;

export const REVIEW_PACKET_LIST_MAX_LIMIT = 100;

/** Every filter is optional; changes come newest recorded first. */
export const ReviewPacketListInput = Schema.Struct({
  host: Schema.optionalKey(TrimmedNonEmptyString),
  repository: Schema.optionalKey(TrimmedNonEmptyString),
  pullRequest: Schema.optionalKey(PositiveInt),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(REVIEW_PACKET_LIST_MAX_LIMIT)),
  ),
});
export type ReviewPacketListInput = typeof ReviewPacketListInput.Type;

export const ReviewPacketListResult = Schema.Struct({
  changes: Schema.Array(ReviewPacketChangeSummary),
  hasMore: Schema.Boolean,
});
export type ReviewPacketListResult = typeof ReviewPacketListResult.Type;

/** Without `head`, the change's latest revision. */
export const ReviewPacketGetInput = Schema.Struct({
  ...ReviewPacketChangeRef.fields,
  head: Schema.optionalKey(CommitSha),
});
export type ReviewPacketGetInput = typeof ReviewPacketGetInput.Type;

export const ReviewPacketGetResult = Schema.Struct({
  packet: Schema.NullOr(ReviewPacket),
  /** Every stored revision of the change, newest recorded first. */
  revisions: Schema.Array(ReviewPacketRevisionSummary),
});
export type ReviewPacketGetResult = typeof ReviewPacketGetResult.Type;

/** A packet folder on the server's own filesystem. */
export const ReviewPacketSubmitInput = Schema.Struct({
  directory: TrimmedNonEmptyString,
});
export type ReviewPacketSubmitInput = typeof ReviewPacketSubmitInput.Type;

export const ReviewPacketSubmitResult = Schema.Struct({
  change: ReviewPacketChangeSummary,
  /** The same revision was stored before and its manifest was replaced. */
  replaced: Schema.Boolean,
  media: Schema.Struct({ copied: NonNegativeInt, reused: NonNegativeInt }),
  pruned: Schema.Struct({ revisions: NonNegativeInt, media: NonNegativeInt }),
});
export type ReviewPacketSubmitResult = typeof ReviewPacketSubmitResult.Type;

export class ReviewPacketRejectedError extends Schema.TaggedError<ReviewPacketRejectedError>()(
  "ReviewPacketRejectedError",
  {
    /** The intake check that failed, such as `ReviewPacketMediaHashMismatchError`. */
    problem: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
  { httpApiStatus: 422 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(ReviewPacketRejectedError)(this, { status: 422 });
  }

  override get message(): string {
    return this.detail;
  }
}

export class ReviewPacketReadError extends Schema.TaggedError<ReviewPacketReadError>()(
  "ReviewPacketReadError",
  {
    operation: Schema.Literals(["list", "get", "mediaType"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not read the stored review packets.";
  }
}
