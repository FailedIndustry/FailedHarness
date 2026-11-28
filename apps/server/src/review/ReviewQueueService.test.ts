import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type PullRequestListEntry,
  type ReviewPacket,
} from "@t3tools/contracts";
import {
  indexReviewPackets,
  rankByMergeReadiness,
  reviewPacketFor,
} from "@t3tools/shared/reviewQueue";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ReviewPackets from "../persistence/ReviewPackets.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ReviewPacketService from "./ReviewPacketService.ts";
import * as ReviewQueueService from "./ReviewQueueService.ts";

const projectId = ProjectId.make("project-1");
const sha = (digit: string) => digit.repeat(40);

const pullRequest = (
  number: number,
  fields: Partial<PullRequestListEntry> = {},
): PullRequestListEntry => ({
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  projectId,
  projectTitle: "App",
  repository: "acme/app",
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  author: null,
  headBranch: `change-${number}`,
  headSha: sha("a"),
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 0,
  deletions: 0,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: `2026-11-${String(10 + (number % 20)).padStart(2, "0")}T00:00:00Z`,
  viewerReviewRequested: false,
  labels: [],
  ...fields,
});

const packet = (input: {
  readonly branch: string;
  readonly verdict: "pass" | "fail";
  readonly paths: ReadonlyArray<string>;
  readonly pullRequest?: number;
}): ReviewPacket => ({
  schema: 1,
  change: {
    repository: "acme/app",
    branch: input.branch,
    base: "main",
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
  },
  revision: { base: sha("b"), head: sha("a"), recordedAt: "2026-11-20T00:00:00Z" },
  status: { verdict: input.verdict },
  claims: [
    {
      id: "claim",
      title: "Claim",
      statement: "It works.",
      result: "seen",
      evidence: [],
      paths: input.paths,
    },
  ],
  blockers: [],
  notes: [],
  media: [],
});

const project = {
  id: projectId,
  title: "App",
  workspaceRoot: "/home/user/app",
} as unknown as OrchestrationProjectShell;

const harness = (entries: ReadonlyArray<PullRequestListEntry>) =>
  ReviewQueueService.layer.pipe(
    Layer.provideMerge(ReviewPacketService.layer),
    Layer.provideMerge(ReviewPackets.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              canonicalKey: "github.com/acme/app",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/acme/app.git",
              },
              provider: SourceControlProviderKind.make("github"),
              displayName: "acme/app",
              owner: "acme",
              name: "app",
            }),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          servesProject: () => Effect.succeed(true),
          list: () =>
            Effect.succeed({
              viewers: {},
              providers: [],
              entries,
              errors: [],
              truncated: false,
              nextCursors: {},
            }),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-queue-" })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const storePacket = Effect.fn("test.storePacket")(function* (stored: ReviewPacket) {
  const repository = yield* ReviewPackets.ReviewPacketRepository;
  yield* repository.put({
    key: { host: "github.com", repository: "acme/app", branch: stored.change.branch },
    packet: stored,
    receivedAt: stored.revision.recordedAt,
    keepRevisions: 20,
  });
});

const seedThread = Effect.fn("test.seedThread")(function* (thread: {
  readonly id: string;
  readonly branch: string;
  readonly running?: boolean;
  readonly extra?: Record<string, unknown>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({ branch: thread.branch, ...thread.extra });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${thread.id}, ${projectId}, ${`Thread ${thread.id}`}, 'codex', 'full-access',
      'default', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', ${payload}
    )
  `;
  if (thread.running === true) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (${`run-${thread.id}`}, ${thread.id}, 1, 'codex', 'running', '2026-11-01T00:00:00Z', '{}')
    `;
  }
});

describe("ReviewQueueService", () => {
  const entries = [
    pullRequest(1),
    pullRequest(2, { baseBranch: "change-1" }),
    pullRequest(3, { checksState: "passing", reviewDecision: "approved" }),
    pullRequest(4, { mergeability: "conflicting" }),
  ];

  it.effect(
    "lists open changes in the pull request list's Merge readiness order, then packets with no pull request",
    () =>
      Effect.gen(function* () {
        yield* storePacket(
          packet({
            branch: "change-1",
            verdict: "pass",
            paths: ["apps/web/src/components/Row.tsx", "packages/contracts/**", "README.md"],
          }),
        );
        yield* storePacket(
          packet({ branch: "change-2", verdict: "fail", paths: ["apps/server/"] }),
        );
        yield* storePacket(packet({ branch: "spike", verdict: "pass", paths: ["docs/user/"] }));
        yield* seedThread({ id: "owner-1", branch: "change-1", running: true });
        yield* seedThread({ id: "owner-2", branch: "change-2" });
        // Neither a side chat nor the coordinator owns the change it sits on.
        yield* seedThread({
          id: "side",
          branch: "change-1",
          extra: { lineage: { sideChat: true } },
        });
        yield* seedThread({ id: "coordinator", branch: "change-1", extra: { coordinator: true } });

        const queue = yield* ReviewQueueService.ReviewQueueService.pipe(
          Effect.flatMap((service) => service.read({ projectId })),
        );

        const packets = yield* ReviewPacketService.ReviewPacketService.pipe(
          Effect.flatMap((service) => service.list({ limit: 100 })),
        );
        const index = indexReviewPackets(packets.changes);
        const listOrder = rankByMergeReadiness(entries, (entry) => reviewPacketFor(index, entry));
        expect(queue.changes.map((change) => change.number)).toEqual([
          ...listOrder.map((entry) => entry.number),
          null,
        ]);
        expect(queue.changes.map((change) => [change.headBranch, change.standing])).toEqual([
          ["change-1", "ready"],
          ["change-3", "no-packet"],
          ["change-2", "not-passing"],
          ["change-4", "no-packet"],
          ["spike", "no-pull-request"],
        ]);

        const [first, , second] = queue.changes;
        expect(first).toMatchObject({
          basedOnThis: [2],
          threads: [{ threadId: ThreadId.make("owner-1"), running: true }],
          areas: ["README.md", "apps/web/src", "packages/contracts"],
        });
        expect(second).toMatchObject({
          basedOn: 1,
          verdict: "fail",
          threads: [{ threadId: ThreadId.make("owner-2"), running: false }],
          areas: ["apps/server"],
        });
        expect(queue.changes[1]?.areas).toBeNull();
        expect(queue.omitted).toBe(0);

        const text = ReviewQueueService.renderReviewQueue(
          queue,
          (id, title) => `[${title}](${id})`,
        );
        expect(text).toContain("1. #1 Change 1 (change-1 → main): ready to go in, verdict pass");
        expect(text).toContain("   Threads: [Thread owner-1](owner-1) (running)");
        expect(text).toContain("   Stacked on #1.");
        expect(text).toContain("5. spike: packet, no pull request yet, verdict pass");
        expect(text).not.toContain("Cut:");
      }).pipe(Effect.provide(harness(entries))),
  );

  it.effect("cuts the queue at its limit and says how many changes it left out", () => {
    const many = Array.from({ length: 25 }, (_, index) => pullRequest(index + 1));
    return Effect.gen(function* () {
      const queue = yield* ReviewQueueService.ReviewQueueService.pipe(
        Effect.flatMap((service) => service.read({ projectId })),
      );
      expect(queue.changes).toHaveLength(ReviewQueueService.REVIEW_QUEUE_LIMITS.changes);
      expect(queue.omitted).toBe(5);
      expect(ReviewQueueService.renderReviewQueue(queue, (id) => id)).toContain(
        "Cut: 5 more changes not shown.",
      );
    }).pipe(Effect.provide(harness(many)));
  });
});

describe("areasOf", () => {
  it("keeps folders a few levels deep from paths, globs and top-level files", () => {
    expect(
      ReviewQueueService.areasOf([
        "apps/web/src/components/pullRequest/Row.tsx",
        "./apps/web/src/state/x.ts",
        "packages/*/src",
        "apps/server/",
        "README.md",
        "**/*.md",
      ]),
    ).toEqual(["README.md", "apps/server", "apps/web/src", "packages"]);
  });
});
