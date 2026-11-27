import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import * as ReviewCommentService from "../../../review/ReviewCommentService.ts";
import { ReviewCommentsToolkit } from "./tools.ts";

const callerThread = (operation: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, operation)),
    Effect.map((scope) => scope.thread.threadId),
  );

// The answering thread is the caller's own, so an agent only ever answers as itself.
export const layer = McpToolAccess.toLayer(ReviewCommentsToolkit, {
  read_review_comments: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("read_review_comments");
      const service = yield* ReviewCommentService.ReviewCommentService;
      const { comments, text } = yield* service
        .forThread(threadId)
        .pipe(Effect.mapError(unavailable));
      return { comments, text };
    }),
  ),
  answer_review_comment: McpToolAccess.actsAsCaller(({ commentId, kind, text, fixedIn }) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("answer_review_comment");
      const service = yield* ReviewCommentService.ReviewCommentService;
      const { comment } = yield* service.answer({ threadId, commentId, kind, text, fixedIn }).pipe(
        Effect.catchTags({
          ReviewCommentRefusedError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          ReviewCommentStoreError: () => Effect.fail(unavailable()),
        }),
      );
      return { state: comment?.state ?? "answered" };
    }),
  ),
});
