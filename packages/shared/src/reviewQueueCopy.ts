import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { ReviewStanding } from "./reviewQueue.ts";

export interface ReviewStandingNote {
  readonly standing: "your-move" | "ready" | "with-agent" | "not-passing";
  readonly text: string;
}

/** One line on where a change stands in review, in words the reviewer can act on. */
export function reviewStandingNote(
  review: ReviewStanding,
  resolve: MFunctionType = mFallback,
): ReviewStandingNote | null {
  const { standing, unsent, open, answered, behind, verdict } = review;
  switch (standing) {
    case "no-packet":
    case "closed":
      return null;
    case "your-move":
      return {
        standing,
        text:
          answered > 0 && unsent > 0
            ? resolve(msg("{answered} answered · {unsent} not sent", { answered, unsent }))
            : answered > 0
              ? resolve(msg("{count} answered", { count: answered }))
              : resolve(msg("{count} not sent", { count: unsent })),
      };
    case "ready":
      return { standing, text: resolve(msg("Ready to review")) };
    case "with-agent":
      return {
        standing,
        text: behind
          ? open > 0
            ? resolve(msg("Packet behind · {count} open", { count: open }))
            : resolve(msg("Packet behind"))
          : resolve(msg("With the agent · {count} open", { count: open })),
      };
    case "not-passing":
      return {
        standing,
        text:
          verdict === "blocked"
            ? resolve(msg("Blocked", { $context: "review packet verdict" }))
            : resolve(msg("Packet failed")),
      };
  }
}
