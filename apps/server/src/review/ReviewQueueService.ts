import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  ReviewPacketRevisionSummary,
  ThreadId,
  type PullRequestListEntry,
  type ReviewPacketChangeSummary,
} from "@t3tools/contracts";
import {
  indexReviewPackets,
  rankByMergeReadiness,
  reviewPacketFor,
  reviewStanding,
} from "@t3tools/shared/reviewQueue";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ownPullRequestRepositories } from "../pullRequest/pullRequestSyncKey.ts";
import { listProjectBranchThreads } from "./owningThreads.ts";
import * as ReviewPacketService from "./ReviewPacketService.ts";

/** The queue lands in a model's context, so it is cut to the changes that lead it. */
export const REVIEW_QUEUE_LIMITS = { changes: 20, areas: 8, threads: 3 } as const;
const AREA_DEPTH = 3;

export const ReviewQueueStanding = Schema.Literals([
  "your-move",
  "ready",
  "with-agent",
  "not-passing",
  "no-packet",
  "no-pull-request",
]);
export type ReviewQueueStanding = typeof ReviewQueueStanding.Type;

export const ReviewQueueChange = Schema.Struct({
  number: Schema.NullOr(PositiveInt),
  title: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  headBranch: Schema.String,
  baseBranch: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  /** The listed pull request whose branch this one is based on. */
  basedOn: Schema.NullOr(PositiveInt),
  /** Listed pull requests based on this one's branch. */
  basedOnThis: Schema.Array(PositiveInt),
  standing: ReviewQueueStanding,
  verdict: Schema.NullOr(ReviewPacketRevisionSummary.fields.verdict),
  behind: Schema.Boolean,
  comments: Schema.Struct({
    unsent: NonNegativeInt,
    open: NonNegativeInt,
    answered: NonNegativeInt,
    resolved: NonNegativeInt,
  }),
  checks: Schema.NullOr(PullRequestChecksState),
  reviewDecision: Schema.NullOr(PullRequestReviewDecision),
  mergeability: Schema.NullOr(PullRequestMergeability),
  threads: Schema.Array(
    Schema.Struct({ threadId: ThreadId, title: Schema.String, running: Schema.Boolean }),
  ),
  /** Folders its packet's claims name; null without a packet. */
  areas: Schema.NullOr(Schema.Array(Schema.String)),
});
export type ReviewQueueChange = typeof ReviewQueueChange.Type;

export const ReviewQueue = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  /** Every open change, in queue order, then packets with no pull request yet. */
  changes: Schema.Array(ReviewQueueChange),
  /** Changes left out past the limit. */
  omitted: NonNegativeInt,
  /** Why pull requests are missing, when they are. */
  pullRequestsUnavailable: Schema.NullOr(Schema.String),
});
export type ReviewQueue = typeof ReviewQueue.Type;

export class ReviewQueueProjectNotFoundError extends Schema.TaggedError<ReviewQueueProjectNotFoundError>()(
  "ReviewQueueProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The project was not found.";
  }
}

export class ReviewQueueReadError extends Schema.TaggedError<ReviewQueueReadError>()(
  "ReviewQueueReadError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not read the review queue (${this.operation}).`;
  }
}

export class ReviewQueueService extends Context.Service<
  ReviewQueueService,
  {
    /** Every open change of a project in Merge readiness order, with what stands behind it. */
    readonly read: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<ReviewQueue, ReviewQueueProjectNotFoundError | ReviewQueueReadError>;
  }
>()("t3/review/ReviewQueueService") {}

/** Folders at most `AREA_DEPTH` deep, from pathspecs that may end in globs or name files. */
export function areasOf(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const areas = new Set<string>();
  for (const path of paths) {
    const segments = path.replace(/^\.?\//, "").split("/");
    const glob = segments.findIndex((segment) => /[*?[{]/.test(segment));
    const literal = glob === -1 ? segments : segments.slice(0, glob);
    const folders = literal.length === segments.length ? literal.slice(0, -1) : literal;
    const area = folders.slice(0, AREA_DEPTH).join("/");
    areas.add(area === "" ? (literal[0] ?? "") : area);
  }
  areas.delete("");
  return [...areas].toSorted();
}

const readError = (operation: string) => (cause: unknown) =>
  new ReviewQueueReadError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const packets = yield* ReviewPacketService.ReviewPacketService;

  const openPullRequests = Effect.fn("ReviewQueueService.openPullRequests")(function* (
    projectId: ProjectId,
  ) {
    if (!(yield* pullRequests.servesProject(projectId))) {
      return { entries: [], unavailable: "The project is on no forge T3 Code reads." };
    }
    return yield* pullRequests.list({ projectId, state: "open", limit: 100 }).pipe(
      Effect.map((listed) => ({
        entries: listed.entries,
        unavailable:
          listed.entries.length === 0 && listed.errors[0] !== undefined
            ? listed.errors[0].message
            : null,
      })),
      Effect.catch((error) => Effect.succeed({ entries: [], unavailable: error.message })),
    );
  });

  const areasFor = Effect.fn("ReviewQueueService.areas")(function* (
    change: ReviewPacketChangeSummary,
  ) {
    if (change.host === null) return null;
    const { packet } = yield* packets
      .get({
        host: change.host,
        repository: change.repository,
        branch: change.branch,
        head: change.head,
      })
      .pipe(Effect.mapError(readError("packet")));
    return packet === null ? null : areasOf(packet.claims.flatMap((claim) => claim.paths));
  });

  const read: ReviewQueueService["Service"]["read"] = Effect.fn("ReviewQueueService.read")(
    function* ({ projectId }) {
      const project = yield* projects.getShell(projectId).pipe(
        Effect.mapError(readError("project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ReviewQueueProjectNotFoundError({ projectId })),
            onSome: Effect.succeed,
          }),
        ),
      );
      const identity = yield* identities.resolve(project.workspaceRoot);
      const repositories = ownPullRequestRepositories(identity).map((candidate) => candidate.key);
      const stored = yield* Effect.forEach(repositories, (key) =>
        packets
          .list({ host: key.host, repository: key.repository, limit: 100 })
          .pipe(Effect.mapError(readError("packets"))),
      ).pipe(Effect.map((lists) => lists.flatMap((list) => list.changes)));
      const index = indexReviewPackets(stored);
      const listed = yield* openPullRequests(projectId);

      const ranked = rankByMergeReadiness(listed.entries, (entry) => reviewPacketFor(index, entry));
      const claimed = new Set(
        ranked.flatMap((entry) => {
          const packet = reviewPacketFor(index, entry);
          return packet === null ? [] : [packet];
        }),
      );
      const listedBranches = new Set(listed.entries.map((entry) => entry.headBranch));
      const unopened = stored.filter(
        (change) =>
          !claimed.has(change) && change.pullRequest === null && !listedBranches.has(change.branch),
      );

      const total = ranked.length + unopened.length;
      const shownEntries = ranked.slice(0, REVIEW_QUEUE_LIMITS.changes);
      const shownUnopened = unopened.slice(
        0,
        Math.max(0, REVIEW_QUEUE_LIMITS.changes - shownEntries.length),
      );
      const owners = yield* listProjectBranchThreads(projectId, [
        ...shownEntries.map((entry) => entry.headBranch),
        ...shownUnopened.map((change) => change.branch),
      ]).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(readError("threads")),
      );
      const threadsOn = (branch: string) =>
        owners
          .filter((thread) => thread.branch === branch)
          .slice(0, REVIEW_QUEUE_LIMITS.threads)
          .map(({ id, title, running }) => ({ threadId: id, title, running }));
      const cappedAreas = (areas: ReadonlyArray<string> | null) =>
        areas === null ? null : areas.slice(0, REVIEW_QUEUE_LIMITS.areas);

      const fromPullRequest = Effect.fn("ReviewQueueService.fromPullRequest")(function* (
        entry: PullRequestListEntry,
      ) {
        const packet = reviewPacketFor(index, entry);
        const standing = reviewStanding(entry, packet);
        return {
          number: entry.number,
          title: entry.title,
          url: entry.url,
          headBranch: entry.headBranch,
          baseBranch: entry.baseBranch,
          draft: entry.isDraft,
          basedOn:
            listed.entries.find((other) => other.headBranch === entry.baseBranch)?.number ?? null,
          basedOnThis: listed.entries
            .filter((other) => other.baseBranch === entry.headBranch)
            .map((other) => other.number),
          // Only open pull requests are listed, so none is closed.
          standing: standing.standing === "closed" ? "no-packet" : standing.standing,
          verdict: standing.verdict,
          behind: standing.behind,
          comments: {
            unsent: standing.unsent,
            open: standing.open,
            answered: standing.answered,
            resolved: standing.resolved,
          },
          checks: entry.checksState ?? null,
          reviewDecision: entry.reviewDecision ?? null,
          mergeability: entry.mergeability,
          threads: threadsOn(entry.headBranch),
          areas: cappedAreas(packet === null ? null : yield* areasFor(packet)),
        } satisfies ReviewQueueChange;
      });

      const fromPacket = Effect.fn("ReviewQueueService.fromPacket")(function* (
        change: ReviewPacketChangeSummary,
      ) {
        return {
          number: null,
          title: null,
          url: null,
          headBranch: change.branch,
          baseBranch: null,
          draft: false,
          basedOn: null,
          basedOnThis: [],
          standing: "no-pull-request",
          verdict: change.verdict,
          behind: false,
          comments: {
            unsent: change.comments?.unsent ?? 0,
            open: change.comments?.open ?? 0,
            answered: change.comments?.answered ?? 0,
            resolved: change.comments?.resolved ?? 0,
          },
          checks: null,
          reviewDecision: null,
          mergeability: null,
          threads: threadsOn(change.branch),
          areas: cappedAreas(yield* areasFor(change)),
        } satisfies ReviewQueueChange;
      });

      const changes = [
        ...(yield* Effect.forEach(shownEntries, fromPullRequest)),
        ...(yield* Effect.forEach(shownUnopened, fromPacket)),
      ];
      return {
        projectId,
        projectTitle: project.title,
        changes,
        omitted: total - changes.length,
        pullRequestsUnavailable: listed.unavailable,
      } satisfies ReviewQueue;
    },
  );

  return ReviewQueueService.of({ read });
});

export const layer = Layer.effect(ReviewQueueService, make);

const STANDING_TEXT: Record<ReviewQueueStanding, string> = {
  "your-move": "needs the owner",
  ready: "ready to go in",
  "with-agent": "with its agent",
  "not-passing": "packet not passing",
  "no-packet": "no review packet",
  "no-pull-request": "packet, no pull request yet",
};

function describe(change: ReviewQueueChange): string {
  const facts = [
    STANDING_TEXT[change.standing],
    ...(change.verdict === null ? [] : [`verdict ${change.verdict}`]),
    ...(change.behind ? ["pushed past its packet"] : []),
    ...(change.comments.unsent > 0 ? [`${change.comments.unsent} unsent comments`] : []),
    ...(change.comments.open > 0 ? [`${change.comments.open} open comments`] : []),
    ...(change.comments.answered > 0 ? [`${change.comments.answered} answered comments`] : []),
    ...(change.draft ? ["draft"] : []),
    ...(change.checks === null ? [] : [`checks ${change.checks}`]),
    ...(change.reviewDecision === null ? [] : [`review ${change.reviewDecision}`]),
    ...(change.mergeability === "conflicting" ? ["conflicts"] : []),
  ];
  return facts.join(", ");
}

/** The queue as a model reads it; `linkOf` renders a thread the way the caller can open it. */
export function renderReviewQueue(
  queue: ReviewQueue,
  linkOf: (threadId: ThreadId, title: string) => string,
): string {
  const lines = [`Review queue for ${queue.projectTitle}, best first:`];
  if (queue.pullRequestsUnavailable !== null) {
    lines.push(`Pull requests unavailable: ${queue.pullRequestsUnavailable}`);
  }
  if (queue.changes.length === 0) lines.push("No open changes.");
  queue.changes.forEach((change, index) => {
    const name =
      change.number === null
        ? change.headBranch
        : `#${change.number} ${change.title ?? ""} (${change.headBranch} → ${change.baseBranch ?? "?"})`;
    lines.push(`${index + 1}. ${name}: ${describe(change)}`);
    if (change.url !== null) lines.push(`   ${change.url}`);
    if (change.basedOn !== null) lines.push(`   Stacked on #${change.basedOn}.`);
    if (change.basedOnThis.length > 0) {
      lines.push(`   Based on it: ${change.basedOnThis.map((number) => `#${number}`).join(", ")}.`);
    }
    if (change.threads.length > 0) {
      const threads = change.threads.map(
        (thread) => `${linkOf(thread.threadId, thread.title)}${thread.running ? " (running)" : ""}`,
      );
      lines.push(`   Threads: ${threads.join(", ")}`);
    }
    lines.push(
      `   Areas: ${change.areas === null ? "unknown (no packet)" : change.areas.join(", ") || "none named"}`,
    );
  });
  if (queue.omitted > 0) lines.push(`Cut: ${queue.omitted} more changes not shown.`);
  return lines.join("\n");
}
