import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  HarnessDescription,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

/** A checkout a harness session runs in, and the thread it belongs to when there is one. */
export interface HarnessCheckout {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly worktreePath: string;
  readonly threadId: ThreadId | null;
}

/** Sent to the thread's agent as written; it names the MCP tools, so it stays English. */
export const PLAYTEST_PROMPT =
  "Run a playtest of this branch with the project's harness: call harness_session_start (it runs hidden and recorded), play each claim of the change through the harness's own commands, mark what you see with harness_mark, then call harness_session_stop, which stores the review packet. Report each claim as seen or not.";

export const MARK_LAST_SECONDS_CHOICES = [10, 30, 60] as const;

/** A checkout offers play only when its `t3.json` declares a harness. */
export const offersHarness = (
  description: HarnessDescription | null | undefined,
): description is HarnessDescription =>
  description != null && description.declared !== null && description.blocked !== "not-declared";

/**
 * Why "Play this branch" cannot start, or null. An unapproved harness is not a reason: starting
 * asks for the approval.
 */
export function playDisabledReason(
  input: {
    readonly description: HarnessDescription;
    readonly hasCheckout: boolean;
    readonly canOperate: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!input.hasCheckout) return resolve(msg("Start a thread on this branch to play it."));
  if (!input.canOperate) return resolve(msg("This connection cannot start harness sessions."));
  return harnessBlockReason(input.description, resolve);
}

/** Why the agent cannot run a playtest from this thread, or null. */
export function playtestDisabledReason(
  input: {
    readonly description: HarnessDescription;
    readonly hasCheckout: boolean;
    readonly canOperate: boolean;
    readonly runtimeMode: RuntimeMode | null;
  },
  resolve: MessageResolver = m,
): string | null {
  const play = playDisabledReason(input, resolve);
  if (play !== null) return play;
  if (input.runtimeMode !== null && input.runtimeMode !== "full-access") {
    return resolve(
      msg("The agent can run the harness only from a thread in Full access. Switch it first."),
    );
  }
  return null;
}

export function harnessBlockReason(
  description: HarnessDescription,
  resolve: MessageResolver = m,
): string | null {
  switch (description.blocked) {
    case "not-found":
      return resolve(msg("The harness path in t3.json is not a file in this checkout."));
    case "policy":
      return description.policyBy === null
        ? resolve(msg("Your organization's policy turns project commands off."))
        : resolve(
            msg("{organization}'s policy turns project commands off.", {
              organization: description.policyBy,
            }),
          );
    case "not-permitted":
      return resolve(msg("This connection may not run project commands."));
    default:
      return null;
  }
}

/**
 * The stream page's address. The server answers a path on itself, so another environment's
 * page is reached through that environment's own base URL.
 */
export function harnessViewerUrl(httpBaseUrl: string | null, path: string): string {
  if (httpBaseUrl === null) return path;
  // A base reached under a path prefix (a relay, a reverse proxy) keeps it: the page derives its
  // assets and signalling from its own address, so the prefix must stay in front of the path.
  const prefix = new URL(httpBaseUrl).pathname.replace(/\/+$/, "");
  return environmentEndpointUrl(httpBaseUrl, `${prefix}${path}`);
}

/** The most recently updated live thread on a branch with a checkout of its own. */
export function pickBranchCheckoutThread<
  T extends {
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly archivedAt: unknown;
    readonly updatedAt: { readonly epochMilliseconds: number } | string;
  },
>(
  threads: ReadonlyArray<T>,
  change: { readonly projectId: ProjectId; readonly branch: string },
): (T & { readonly worktreePath: string }) | null {
  let best: (T & { readonly worktreePath: string }) | null = null;
  for (const thread of threads) {
    if (
      thread.projectId !== change.projectId ||
      thread.branch !== change.branch ||
      thread.worktreePath === null ||
      thread.archivedAt !== null
    )
      continue;
    if (best === null || updatedMs(thread) > updatedMs(best))
      best = thread as T & { readonly worktreePath: string };
  }
  return best;
}

const updatedMs = (thread: {
  readonly updatedAt: { readonly epochMilliseconds: number } | string;
}) =>
  typeof thread.updatedAt === "string"
    ? Date.parse(thread.updatedAt)
    : thread.updatedAt.epochMilliseconds;
