import { OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ReviewQueueService from "../../../review/ReviewQueueService.ts";

const ReadReviewQueueTool = Tool.make("read_review_queue", {
  description:
    "Read a project's open changes, best to merge first, as the review queue ranks them: each one's standing and why (packet verdict, comments, pushed past its packet), checks, review, conflicts, stack, the threads on its branch, and the folders it touches. Also packets with no pull request yet. Defaults to this thread's project.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  success: Schema.Struct({ text: Schema.String, ...ReviewQueueService.ReviewQueue.fields }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ReviewQueueService.ReviewQueueService,
  ],
})
  .annotate(Tool.Title, "Read the review queue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ReviewQueueToolkit = Toolkit.make(ReadReviewQueueTool);
