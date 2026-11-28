import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  REVIEW_COMMENT_LIMITS,
  ReviewCommentAnswerKind,
  ReviewCommentId,
  ReviewCommentState,
  ReviewFixCommit,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ReviewCommentService from "../../../review/ReviewCommentService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ReviewCommentService.ReviewCommentService,
  ],
};

const ReadReviewCommentsTool = Tool.make("read_review_comments", {
  ...shared,
  description:
    "Read the review comments a person sent about this thread's change that still wait on you: each one's id, where it points (claim, code lines, image region, clip range, with local file paths) and what it asks.",
  success: Schema.Struct({ comments: NonNegativeInt, text: Schema.String }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AnswerReviewCommentTool = Tool.make("answer_review_comment", {
  ...shared,
  description:
    "Answer one review comment by its id: `fixed` with `fixedIn`, the commit the fix is in; `answered` when nothing needs to change; `disagrees` with your reason. Only the reviewer resolves a comment.",
  parameters: Schema.Struct({
    commentId: ReviewCommentId,
    kind: ReviewCommentAnswerKind,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(REVIEW_COMMENT_LIMITS.textChars)),
    fixedIn: Schema.optional(ReviewFixCommit),
  }),
  success: Schema.Struct({ state: ReviewCommentState }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ReviewCommentsToolkit = Toolkit.make(ReadReviewCommentsTool, AnswerReviewCommentTool);
