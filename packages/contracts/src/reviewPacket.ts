import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, NonNegativeInt } from "./baseSchemas.ts";

/**
 * Version 1 of the review packet a project's harness assembles and the claims file the
 * implementing agent writes. Published JSON Schemas: `packages/contracts/schemas`.
 * Rules a JSON Schema cannot express: a clip's `endMs` is at least its `startMs`, and every
 * evidence `media` names an entry of `media[]` (see `findDanglingMediaReferences`).
 */

const REVIEW_PACKET_SCHEMA_VERSION = 1;

const ClaimId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u));
const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const MediaId = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));
const UtcTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u),
);
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
  media: MediaId,
  caption: Schema.optionalKey(Schema.String),
});

const ClipEvidence = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("clip"),
  media: MediaId,
  recording: Schema.optionalKey(MediaId),
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
  id: MediaId,
  file: Schema.String,
  type: Schema.String,
  bytes: NonNegativeInt,
  width: Schema.optionalKey(NonNegativeInt),
  height: Schema.optionalKey(NonNegativeInt),
  durationMs: Schema.optionalKey(NonNegativeInt),
});

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
      verdict: Schema.Literals(["pass", "fail", "blocked"]),
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
