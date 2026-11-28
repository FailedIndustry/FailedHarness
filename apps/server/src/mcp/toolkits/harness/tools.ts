import {
  HARNESS_MARK_LAST_MAX_SECONDS,
  HARNESS_MARK_NOTE_MAX_CHARS,
  HarnessDoctorRow,
  HarnessNetwork,
  HarnessPacketOutcome,
  NonNegativeInt,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as HarnessService from "../../../harness/HarnessService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ReviewPacketService from "../../../review/ReviewPacketService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerSettings.ServerSettingsService,
    HarnessService.HarnessService,
    ReviewPacketService.ReviewPacketService,
  ],
};

const SessionResult = Schema.Struct({
  sessionId: Schema.NullOr(Schema.String),
  phase: Schema.NullOr(Schema.String),
  text: Schema.String,
});

const HarnessSessionStartTool = Tool.make("harness_session_start", {
  ...shared,
  description:
    "Start a hidden playtest session of this thread's checkout with the project's harness (t3.json `harness`). `net` defaults to isolated (no outbound network); `record` defaults to on there, off for direct, and marks need it. Mark with harness_mark; end with harness_session_stop, which stores the review packet. Needs Full access.",
  parameters: Schema.Struct({
    net: Schema.optional(HarnessNetwork),
    record: Schema.optional(Schema.Boolean),
  }),
  success: SessionResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const HarnessSessionStatusTool = Tool.make("harness_session_status", {
  ...shared,
  description:
    "Read this checkout's harness session: phase, recording, marks, and after it stopped the stored packet's outcome.",
  success: SessionResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const HarnessMarkTool = Tool.make("harness_mark", {
  ...shared,
  description:
    "Mark a moment of this checkout's running, recorded harness session with a note; it becomes packet evidence. `lastSeconds` marks the range ending now instead, for what just happened.",
  parameters: Schema.Struct({
    note: TrimmedNonEmptyString.check(Schema.isMaxLength(HARNESS_MARK_NOTE_MAX_CHARS)),
    lastSeconds: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HARNESS_MARK_LAST_MAX_SECONDS })),
    ),
  }),
  success: Schema.Struct({ markCount: NonNegativeInt }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const HarnessSessionStopTool = Tool.make("harness_session_stop", {
  ...shared,
  description: "Stop this checkout's harness session, then assemble and store its review packet.",
  success: Schema.Struct({ packet: HarnessPacketOutcome, text: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const HarnessDoctorTool = Tool.make("harness_doctor", {
  ...shared,
  description:
    "List what the project's harness needs on this machine, with instructions for anything missing. A person runs setup from the project's settings.",
  success: Schema.Struct({ ready: Schema.Boolean, rows: Schema.Array(HarnessDoctorRow) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const HarnessToolkit = Toolkit.make(
  HarnessSessionStartTool,
  HarnessSessionStatusTool,
  HarnessMarkTool,
  HarnessSessionStopTool,
  HarnessDoctorTool,
);
