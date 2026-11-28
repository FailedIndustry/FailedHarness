import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * What a project's harness verbs print (one JSON document each), read tolerantly: unknown fields
 * are ignored and most are optional, so a harness can say more than T3 Code reads.
 */

export const HarnessSessionBy = Schema.Literals(["person", "agent"]);
export type HarnessSessionBy = typeof HarnessSessionBy.Type;

export const HarnessNetwork = Schema.Literals(["isolated", "direct"]);
export type HarnessNetwork = typeof HarnessNetwork.Type;

const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

/** One dependency `doctor --json` reports, with what to do about it when it is not there. */
export const HarnessDoctorRow = Schema.Struct({
  id: Schema.String,
  name: optionalNullable(Schema.String),
  /** `present` (or `ok`) when nothing needs doing; anything else needs the row's instructions. */
  state: Schema.String,
  detail: optionalNullable(Schema.String),
  fix: optionalNullable(Schema.String),
  instructions: optionalNullable(Schema.String),
});
export type HarnessDoctorRow = typeof HarnessDoctorRow.Type;

/** `doctor --json` answers with the rows, bare or under `rows`/`dependencies`. */
export const HarnessDoctorOutput = Schema.Union([
  Schema.Array(HarnessDoctorRow),
  Schema.Struct({ rows: Schema.Array(HarnessDoctorRow) }),
  Schema.Struct({ dependencies: Schema.Array(HarnessDoctorRow) }),
]);
export type HarnessDoctorOutput = typeof HarnessDoctorOutput.Type;

export const isHarnessDoctorRowReady = (row: Pick<HarnessDoctorRow, "state">) =>
  row.state === "present" || row.state === "ok";

/** How to reach a streamed session. The password stays on the server. */
export const HarnessAttach = Schema.Struct({
  protocol: optionalNullable(Schema.String),
  transport: optionalNullable(Schema.String),
  url: optionalNullable(Schema.String),
  /** The subfolder the stream is served under, when the harness honored `T3CODE_STREAM_PATH`. */
  path: optionalNullable(Schema.String),
  user: optionalNullable(Schema.String),
  password: optionalNullable(Schema.String),
  port: optionalNullable(Schema.Number),
  relayed: optionalNullable(Schema.Boolean),
  offer: optionalNullable(Schema.String),
});
export type HarnessAttach = typeof HarnessAttach.Type;

/** What `session start` (and `session status` under `session`) answers. */
export const HarnessSessionOutput = Schema.Struct({
  ok: optionalNullable(Schema.Boolean),
  id: optionalNullable(Schema.String),
  slot: optionalNullable(Schema.Number),
  by: optionalNullable(Schema.String),
  streamed: optionalNullable(Schema.Boolean),
  net: optionalNullable(Schema.String),
  outbound: optionalNullable(Schema.Boolean),
  stream: optionalNullable(Schema.String),
  recorded: optionalNullable(Schema.Boolean),
  recording: optionalNullable(Schema.String),
  marks: optionalNullable(Schema.String),
  attach: optionalNullable(HarnessAttach),
});
export type HarnessSessionOutput = typeof HarnessSessionOutput.Type;

export const HarnessSessionStatusOutput = Schema.Struct({
  ok: optionalNullable(Schema.Boolean),
  running: optionalNullable(Schema.Boolean),
  phase: optionalNullable(Schema.String),
  session: optionalNullable(HarnessSessionOutput),
  attach: optionalNullable(HarnessAttach),
  markCount: optionalNullable(Schema.Number),
});
export type HarnessSessionStatusOutput = typeof HarnessSessionStatusOutput.Type;

export const HarnessSessionStopOutput = Schema.Struct({
  ok: optionalNullable(Schema.Boolean),
  id: optionalNullable(Schema.String),
  recorded: optionalNullable(Schema.Boolean),
  recording: optionalNullable(Schema.String),
  durationMs: optionalNullable(Schema.Number),
  video: optionalNullable(Schema.String),
  marks: optionalNullable(Schema.String),
  markCount: optionalNullable(Schema.Number),
});
export type HarnessSessionStopOutput = typeof HarnessSessionStopOutput.Type;

export const HarnessMarkOutput = Schema.Struct({
  ok: optionalNullable(Schema.Boolean),
  note: optionalNullable(Schema.String),
  atMs: optionalNullable(Schema.Number),
  startMs: optionalNullable(Schema.Number),
  endMs: optionalNullable(Schema.Number),
});
export type HarnessMarkOutput = typeof HarnessMarkOutput.Type;

/** `packet` names the folder it assembled, or leaves it at `packet/` in the output folder. */
export const HarnessPacketOutput = Schema.Struct({
  ok: optionalNullable(Schema.Boolean),
  packet: optionalNullable(Schema.String),
  path: optionalNullable(Schema.String),
  directory: optionalNullable(Schema.String),
});
export type HarnessPacketOutput = typeof HarnessPacketOutput.Type;

/** A failed verb answers `{"ok": false, "error": "..."}` with a non-zero exit code. */
export const HarnessFailureOutput = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.Union([Schema.String, Schema.Struct({ message: Schema.String })])),
});
export type HarnessFailureOutput = typeof HarnessFailureOutput.Type;

export const HarnessSessionId = TrimmedNonEmptyString.pipe(Schema.brand("HarnessSessionId"));
export type HarnessSessionId = typeof HarnessSessionId.Type;

export const HarnessSessionPhase = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
]);
export type HarnessSessionPhase = typeof HarnessSessionPhase.Type;

export const HarnessPacketOutcome = Schema.Struct({
  status: Schema.Literals(["stored", "failed"]),
  detail: Schema.String,
});
export type HarnessPacketOutcome = typeof HarnessPacketOutcome.Type;

/** A session T3 Code started. The stream's password never leaves the server. */
export const HarnessSession = Schema.Struct({
  id: HarnessSessionId,
  projectId: ProjectId,
  worktreePath: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  by: HarnessSessionBy,
  net: HarnessNetwork,
  phase: HarnessSessionPhase,
  /** The game, its server and the stream server can make outbound connections. */
  outbound: Schema.Boolean,
  streamed: Schema.Boolean,
  /** A streamed session the server can proxy; open it with `harness.viewer`. */
  viewable: Schema.Boolean,
  recorded: Schema.Boolean,
  recording: Schema.NullOr(Schema.String),
  markCount: NonNegativeInt,
  slot: NonNegativeInt,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  packet: Schema.NullOr(HarnessPacketOutcome),
});
export type HarnessSession = typeof HarnessSession.Type;

export const HarnessSetupState = Schema.Struct({
  projectId: ProjectId,
  phase: Schema.Literals(["running", "succeeded", "failed"]),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type HarnessSetupState = typeof HarnessSetupState.Type;

/** Every session this environment's server started and has not forgotten, and running setups. */
export const HarnessSnapshot = Schema.Struct({
  sessions: Schema.Array(HarnessSession),
  setups: Schema.Array(HarnessSetupState),
});
export type HarnessSnapshot = typeof HarnessSnapshot.Type;

/** Why the harness may not run here, worded to follow "The harness cannot run: ". */
export const HarnessBlock = Schema.Literals([
  "not-declared",
  "not-found",
  "not-approved",
  "policy",
  "not-permitted",
]);
export type HarnessBlock = typeof HarnessBlock.Type;

export const HarnessDescribeInput = Schema.Struct({
  projectId: ProjectId,
  /** The checkout to read `t3.json` from; the project folder when absent. */
  worktreePath: Schema.optional(Schema.String),
});
export type HarnessDescribeInput = typeof HarnessDescribeInput.Type;

export const HarnessDescription = Schema.Struct({
  /** The `harness` path as this checkout's `t3.json` holds it; null when it declares none. */
  declared: Schema.NullOr(Schema.String),
  approved: Schema.Boolean,
  /** Null when it can run for a person here. */
  blocked: Schema.NullOr(HarnessBlock),
  /** The organization whose policy turns project commands off, when `blocked` is `policy`. */
  policyBy: Schema.NullOr(Schema.String),
});
export type HarnessDescription = typeof HarnessDescription.Type;

export const HarnessStartInput = Schema.Struct({
  projectId: ProjectId,
  worktreePath: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  by: HarnessSessionBy,
  net: Schema.optional(HarnessNetwork),
});
export type HarnessStartInput = typeof HarnessStartInput.Type;

export const HarnessSessionInput = Schema.Struct({ sessionId: HarnessSessionId });
export type HarnessSessionInput = typeof HarnessSessionInput.Type;

export const HARNESS_MARK_NOTE_MAX_CHARS = 500;
export const HARNESS_MARK_LAST_MAX_SECONDS = 600;

export const HarnessMarkInput = Schema.Struct({
  sessionId: HarnessSessionId,
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(HARNESS_MARK_NOTE_MAX_CHARS)),
  /** Mark the range ending now instead of the moment. */
  lastSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HARNESS_MARK_LAST_MAX_SECONDS })),
  ),
});
export type HarnessMarkInput = typeof HarnessMarkInput.Type;

export const HarnessMarkResult = Schema.Struct({ session: HarnessSession });
export type HarnessMarkResult = typeof HarnessMarkResult.Type;

export const HarnessViewerResult = Schema.Struct({
  /** Same-origin path of the stream page; it carries a viewer token, so it is not for sharing. */
  path: Schema.String,
});
export type HarnessViewerResult = typeof HarnessViewerResult.Type;

export const HarnessProjectInput = Schema.Struct({ projectId: ProjectId });
export type HarnessProjectInput = typeof HarnessProjectInput.Type;

export const HarnessDoctorResult = Schema.Struct({
  rows: Schema.Array(HarnessDoctorRow),
  ready: Schema.Boolean,
});
export type HarnessDoctorResult = typeof HarnessDoctorResult.Type;

export const HarnessPacketInput = Schema.Struct({
  projectId: ProjectId,
  worktreePath: TrimmedNonEmptyString,
});
export type HarnessPacketInput = typeof HarnessPacketInput.Type;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  reason: Schema.Literals([
    ...HarnessBlock.literals,
    "session-not-found",
    "session-running",
    "not-streamed",
    "slots-exhausted",
    "verb-failed",
    "invalid-output",
    "unavailable",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
