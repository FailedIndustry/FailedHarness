import { type HarnessSession, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HarnessService from "../../../harness/HarnessService.ts";
import { collectPacket } from "../../../harness/harnessPackets.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { projectCommandsForAgent } from "../../../workspace/TaskFolders.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { HarnessToolkit } from "./tools.ts";

const failed = (error: { readonly reason: string; readonly detail: string }) =>
  error.reason === "unavailable"
    ? unavailable()
    : new OrchestratorMcpFailure({
        code:
          error.reason === "not-permitted" || error.reason === "policy"
            ? "capability_denied"
            : "invalid_request",
        message: error.detail,
      });

/**
 * The calling thread's checkout, and whether it may have the project's harness run: by the same
 * rule as the project's other commands, only from a thread in Full access. The modes are read at
 * each call, so a thread switched out of Full access stops here.
 */
const callerCheckout = Effect.gen(function* () {
  const context = yield* loadCaller();
  const thread = context.caller;
  if (thread === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Only an agent running in a T3 thread can use the project's harness.",
    });
  }
  const settings = yield* ServerSettings.ServerSettingsService;
  return {
    projectId: thread.projectId,
    threadId: thread.id,
    worktreePath: thread.worktreePath ?? undefined,
    projectCommands: projectCommandsForAgent(
      thread.linkOrigin,
      thread,
      settings.managedPolicy?.limits?.maxRuntimeMode,
    ),
  };
});

const ownSession = (
  snapshot: { readonly sessions: ReadonlyArray<HarnessSession> },
  checkout: { readonly projectId: string; readonly worktreePath: string | undefined },
) =>
  snapshot.sessions.find(
    (session) =>
      session.projectId === checkout.projectId &&
      (checkout.worktreePath === undefined || session.worktreePath === checkout.worktreePath),
  ) ?? null;

const describeSession = (session: HarnessSession | null) => {
  if (session === null) return "No harness session for this checkout.";
  const parts = [
    `Session ${session.id}: ${session.phase}`,
    `by ${session.by}`,
    `network ${session.net}${session.outbound ? " (outbound possible)" : ""}`,
    session.recorded ? `recorded, ${session.markCount} marks` : "not recorded (marks refused)",
  ];
  if (session.error !== null) parts.push(`error: ${session.error}`);
  if (session.packet !== null)
    parts.push(`packet ${session.packet.status}: ${session.packet.detail}`);
  return `${parts.join("; ")}.`;
};

/** An agent drives the game with the harness's own commands; these reach T3's session. */
const withCommandEnv = Effect.fn("HarnessMcp.withCommandEnv")(function* (
  session: HarnessSession | null,
) {
  const text = describeSession(session);
  if (session === null || session.phase !== "running") return text;
  const harness = yield* HarnessService.HarnessService;
  const env = yield* harness.commandEnv(session.id);
  if (Option.isNone(env)) return text;
  const assignments = Object.entries(env.value)
    .filter(([name]) => name !== "T3CODE_STREAM_PATH")
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(" ");
  return `${text} Run the harness's own commands for this session with these set: ${assignments}`;
});

export const layer = McpToolAccess.toLayer(HarnessToolkit, {
  harness_session_start: McpToolAccess.actsAsCaller(({ net, record }) =>
    Effect.gen(function* () {
      const checkout = yield* callerCheckout;
      const harness = yield* HarnessService.HarnessService;
      const session = yield* harness
        .start({ ...checkout, by: "agent", net, record })
        .pipe(Effect.mapError(failed));
      return { sessionId: session.id, phase: session.phase, text: yield* withCommandEnv(session) };
    }),
  ),
  harness_session_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const checkout = yield* callerCheckout;
      const harness = yield* HarnessService.HarnessService;
      const session = ownSession(yield* harness.snapshot, checkout);
      return {
        sessionId: session?.id ?? null,
        phase: session?.phase ?? null,
        text: yield* withCommandEnv(session),
      };
    }),
  ),
  harness_mark: McpToolAccess.actsAsCaller(({ note, lastSeconds }) =>
    Effect.gen(function* () {
      const checkout = yield* callerCheckout;
      const harness = yield* HarnessService.HarnessService;
      const session = ownSession(yield* harness.snapshot, checkout);
      if (session === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "This checkout has no harness session to mark. Start one with harness_session_start.",
        });
      }
      const marked = yield* harness
        .mark({ sessionId: session.id, note, lastSeconds })
        .pipe(Effect.mapError(failed));
      return { markCount: marked.markCount };
    }),
  ),
  harness_session_stop: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const checkout = yield* callerCheckout;
      const harness = yield* HarnessService.HarnessService;
      const current = ownSession(yield* harness.snapshot, checkout);
      if (current === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This checkout has no harness session to stop.",
        });
      }
      const session = yield* harness.stop({ sessionId: current.id }).pipe(Effect.mapError(failed));
      const packet = yield* collectPacket({
        projectId: session.projectId,
        worktreePath: session.worktreePath,
        projectCommands: checkout.projectCommands,
      }).pipe(
        Effect.catchTags({
          HarnessError: (error) =>
            Effect.succeed({ status: "failed" as const, detail: error.detail }),
        }),
      );
      yield* harness.notePacket(session.id, packet);
      return { packet, text: describeSession({ ...session, packet }) };
    }),
  ),
  harness_doctor: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const checkout = yield* callerCheckout;
      const harness = yield* HarnessService.HarnessService;
      return yield* harness
        .doctor({ projectId: checkout.projectId, projectCommands: checkout.projectCommands })
        .pipe(Effect.mapError(failed));
    }),
  ),
});
