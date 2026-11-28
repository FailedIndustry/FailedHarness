import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import * as ReviewQueueService from "../../../review/ReviewQueueService.ts";
import { ReviewQueueToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ReviewQueueToolkit, {
  read_review_queue: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* ReviewQueueService.ReviewQueueService;
      const queue = yield* service.read({ projectId }).pipe(
        Effect.catchTags({
          ReviewQueueProjectNotFoundError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          ReviewQueueReadError: () => Effect.fail(unavailable()),
        }),
      );
      const text = ReviewQueueService.renderReviewQueue(queue, (threadId, title) =>
        McpInvocationContext.threadLinkFor(scope, threadId, title),
      );
      return { text, ...queue };
    }),
  ),
});
