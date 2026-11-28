import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ReviewQueueService from "../../../review/ReviewQueueService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ReviewQueueHandlers from "./handlers.ts";
import { ReviewQueueToolkit } from "./tools.ts";

const CALLER = ThreadId.make("thread-caller");
const OWNER = ThreadId.make("thread-owner");
const OTHER_PROJECT = ProjectId.make("project-other");

const scope = (input: {
  readonly capabilities: ReadonlyArray<McpInvocationContext.McpCapability>;
  readonly outside?: boolean;
}): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "session-1",
  issuedAt: 0,
  capabilities: new Set(input.capabilities),
  thread:
    input.outside === true
      ? undefined
      : {
          threadId: CALLER,
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
  client:
    input.outside === true
      ? { sessionId: "client-1", label: "Claude Code", access: "full-access" }
      : undefined,
});

const readQueue = Effect.fn("test.readQueue")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
  params: { readonly projectId?: ProjectId },
) {
  const read: Array<ProjectId> = [];
  const dependencies = Layer.mergeAll(
    McpToolAccessTestkit.liveThreadsLayer,
    Layer.mock(ReviewQueueService.ReviewQueueService)({
      read: ({ projectId }) =>
        Effect.sync(() => {
          read.push(projectId);
          return {
            projectId,
            projectTitle: "App",
            changes: [
              {
                number: 7,
                title: "Trade",
                url: "https://github.com/acme/app/pull/7",
                headBranch: "trade",
                baseBranch: "main",
                draft: false,
                basedOn: null,
                basedOnThis: [],
                standing: "ready",
                verdict: "pass",
                behind: false,
                comments: { unsent: 0, open: 0, answered: 0, resolved: 0 },
                checks: "passing",
                reviewDecision: null,
                mergeability: "mergeable",
                threads: [{ threadId: OWNER, title: "Trade work", running: false }],
                areas: ["apps/web/src"],
              },
            ],
            omitted: 0,
            pullRequestsUnavailable: null,
          };
        }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
  );
  const toolkit = yield* ReviewQueueToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ReviewQueueHandlers.layer).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  const chunks = yield* toolkit
    .handle("read_review_queue", params)
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  return { result: chunks.at(-1)?.result, read };
});

describe("read_review_queue", () => {
  it.effect("reads the calling thread's project and links the threads that own each change", () =>
    Effect.gen(function* () {
      const { result, read } = yield* readQueue(scope({ capabilities: ["orchestration"] }), {});
      expect(read).toEqual([McpToolAccessTestkit.liveThreadShell(CALLER).projectId]);
      expect(result).toMatchObject({ omitted: 0, changes: [{ number: 7 }] });
      const text = (result as { readonly text: string }).text;
      expect(text).toContain("1. #7 Trade (trade → main): ready to go in, verdict pass");
      expect(text).toContain(
        `Threads: ${McpInvocationContext.threadLinkFor(scope({ capabilities: [] }), OWNER, "Trade work")}`,
      );
    }),
  );

  it.effect("reads another project when the caller names one", () =>
    Effect.gen(function* () {
      const { read } = yield* readQueue(scope({ capabilities: ["orchestration"] }), {
        projectId: OTHER_PROJECT,
      });
      expect(read).toEqual([OTHER_PROJECT]);
    }),
  );

  it.effect("refuses a credential that cannot read threads, before reading any project", () =>
    Effect.gen(function* () {
      const { result, read } = yield* readQueue(scope({ capabilities: ["preview"] }), {});
      expect(result).toMatchObject({ code: "capability_denied" });
      expect(read).toEqual([]);
    }),
  );

  it.effect("asks a client outside a thread to name the project", () =>
    Effect.gen(function* () {
      const outside = scope({ capabilities: ["orchestration"], outside: true });
      const { result, read } = yield* readQueue(outside, {});
      expect(result).toMatchObject({ code: "target_required" });
      expect(read).toEqual([]);
      expect((yield* readQueue(outside, { projectId: OTHER_PROJECT })).read).toEqual([
        OTHER_PROJECT,
      ]);
    }),
  );
});
