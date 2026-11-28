import {
  HarnessError,
  type HarnessPacketOutcome,
  type HarnessSession,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ReviewPacketService from "../review/ReviewPacketService.ts";
import type { ProjectCommandsNow } from "../workspace/TaskFolders.ts";
import * as HarnessService from "./HarnessService.ts";

/**
 * Runs the harness's `packet` in a checkout and stores what it assembled through the packet
 * intake, which copies only media it does not hold yet.
 */
export const collectPacket = Effect.fn("HarnessService.collectPacket")(function* (input: {
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly projectCommands: ProjectCommandsNow;
}) {
  const harness = yield* HarnessService.HarnessService;
  const packets = yield* ReviewPacketService.ReviewPacketService;
  const { directory } = yield* harness.packet(input);
  const stored = yield* packets.submit({ directory }).pipe(
    Effect.mapError(
      (error) =>
        new HarnessError({
          reason: "verb-failed",
          detail: `T3 Code could not store the harness's packet: ${error.message}`,
        }),
    ),
  );
  const { change, media } = stored;
  const claims = change.claims.seen + change.claims.notSeen + change.claims.untested;
  return {
    status: "stored",
    detail: `${stored.replaced ? "Replaced" : "Stored"} the packet for ${change.branch} at ${change.head.slice(0, 12)} (${change.verdict}): ${claims} claims, ${media.copied + media.reused} media (${media.copied} copied).`,
  } satisfies HarnessPacketOutcome;
});

/** After a session stops: its packet, recorded on the session so every client sees the outcome. */
export const collectPacketAfter = Effect.fn("HarnessService.collectPacketAfter")(function* (
  session: HarnessSession,
  projectCommands: ProjectCommandsNow,
) {
  const harness = yield* HarnessService.HarnessService;
  const outcome = yield* collectPacket({
    projectId: session.projectId,
    worktreePath: session.worktreePath,
    projectCommands,
  }).pipe(
    Effect.catchTags({
      HarnessError: (error) =>
        Effect.succeed({ status: "failed", detail: error.detail } satisfies HarnessPacketOutcome),
    }),
  );
  yield* harness.notePacket(session.id, outcome);
});
