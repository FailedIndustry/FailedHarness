import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type ReviewCommentAnchorInput,
  type ReviewPacket,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewComments from "../persistence/ReviewComments.ts";
import * as ReviewPackets from "../persistence/ReviewPackets.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ReviewCommentService from "./ReviewCommentService.ts";
import * as ReviewPacketService from "./ReviewPacketService.ts";

const FORGE_URL = "https://github.com/acme/app.git";
const change = { host: "github.com", repository: "acme/app", branch: "trade-in-world" } as const;
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const media = (digit: string) => `sha256:${digit.repeat(64)}`;
const IMAGE = media("1");
const CLIP = media("2");
const RECORDING = media("3");
const RECUT = media("4");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  GitVcsDriver.GitVcsDriver.pipe(
    Effect.flatMap((driver) =>
      driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 }),
    ),
    Effect.map((result) => result.stdout.trim()),
  );

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";

/**
 * A forge stand-in and a project checkout whose origin names GitHub but fetches from it. With
 * `clone: "base"`, the checkout is cloned before the change's commits exist.
 */
const makeRepositories = Effect.fn("test.makeRepositories")(function* (options: {
  readonly clone: "base" | "head";
}) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-comments-" });
  const remote = `${root}/remote`;
  const workspace = `${root}/workspace`;
  yield* fs.makeDirectory(`${remote}/src`, { recursive: true });
  yield* fs.makeDirectory(`${remote}/docs`, { recursive: true });
  yield* git(remote, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(remote, ["config", "user.email", "test@example.com"]);
  yield* git(remote, ["config", "user.name", "Test"]);
  // Forges let a checkout fetch any reachable commit by its sha.
  yield* git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const commit = Effect.fn("test.commit")(function* (
    files: Record<string, string>,
    message: string,
  ) {
    for (const [path, contents] of Object.entries(files)) {
      yield* fs.writeFileString(`${remote}/${path}`, contents);
      yield* git(remote, ["add", path]);
    }
    yield* git(remote, ["commit", "--quiet", "-m", message]);
    return yield* git(remote, ["rev-parse", "HEAD"]);
  });
  const clone = Effect.gen(function* () {
    yield* git(root, ["clone", "--quiet", remote, workspace]);
    yield* git(workspace, ["remote", "set-url", "origin", FORGE_URL]);
    yield* git(workspace, ["config", `url.${remote}.insteadOf`, FORGE_URL]);
  });
  const base = yield* commit(
    { "src/trade.ts": lines(10, "trade"), "docs/notes.md": "notes\n" },
    "base",
  );
  if (options.clone === "base") yield* clone;
  yield* git(remote, ["checkout", "--quiet", "-b", change.branch]);
  const head = yield* commit(
    { "src/trade.ts": lines(10, "vendor"), "docs/notes.md": "more notes\n" },
    "trade beside the vendor",
  );
  const next = yield* commit({ "docs/notes.md": "notes\n" }, "drop the notes change");
  if (options.clone === "head") yield* clone;
  return { root, workspace, base, head, next };
});

const packetAt = (input: {
  readonly base: string;
  readonly head: string;
  readonly recordedAt: string;
  readonly latest: boolean;
  readonly branch?: string;
  readonly pullRequest?: number;
}): ReviewPacket => ({
  schema: 1,
  change: {
    repository: "acme/app",
    branch: input.branch ?? change.branch,
    base: "main",
    ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
  },
  revision: { base: input.base, head: input.head, recordedAt: input.recordedAt },
  status: { verdict: "pass" },
  claims: [
    {
      id: "trade-in-world",
      title: "Trade in world",
      statement: "Trading happens beside the vendor.",
      result: "seen",
      evidence: input.latest
        ? [
            {
              id: "recut",
              kind: "clip",
              media: RECUT,
              recording: RECORDING,
              startMs: 4000,
              endMs: 30000,
            },
          ]
        : [
            { id: "shot", kind: "image", media: IMAGE },
            {
              id: "walk",
              kind: "clip",
              media: CLIP,
              recording: RECORDING,
              startMs: 10000,
              endMs: 20000,
            },
          ],
      paths: ["src/"],
    },
    ...(input.latest
      ? []
      : [
          {
            id: "smelt",
            title: "Smelt ores",
            statement: "Ores smelt into bars.",
            result: "untested" as const,
            evidence: [],
            paths: [],
          },
        ]),
  ],
  blockers: [],
  notes: [],
  media: input.latest
    ? [{ id: RECUT, file: "recut.mp4", type: "video/mp4", bytes: 4, durationMs: 26000 }]
    : [
        { id: IMAGE, file: "shot.png", type: "image/png", bytes: 4, width: 1280, height: 720 },
        { id: CLIP, file: "walk.mp4", type: "video/mp4", bytes: 4, durationMs: 10000 },
      ],
});

interface Sent {
  readonly threadId: string;
  readonly mode: string;
  readonly createdBy: string;
  readonly creationSource: string;
  readonly text: string;
}

/** What the mocked stores read at call time; a test fills it in once its repositories exist. */
interface World {
  workspace: string;
  readonly threads: Array<Pick<OrchestrationV2AppThread, "id" | "projectId" | "branch">>;
  readonly sent: Array<Sent>;
}

const makeWorld = (): World => ({ workspace: "", threads: [], sent: [] });

const harness = (world: World) => {
  const shells = () =>
    [
      { id: projectId, workspaceRoot: world.workspace },
      { id: otherProjectId, workspaceRoot: `${world.workspace}-elsewhere` },
    ] as unknown as ReadonlyArray<OrchestrationProjectShell>;
  return ReviewCommentService.layer.pipe(
    Layer.provideMerge(ReviewPacketService.layer),
    Layer.provideMerge(Layer.mergeAll(ReviewComments.layer, ReviewPackets.layer)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.sync(shells),
          getShell: (id) =>
            Effect.sync(() => Option.fromNullishOr(shells().find((shell) => shell.id === id))),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          findThread: (threadId) =>
            Effect.sync(() => {
              const thread = world.threads.find((candidate) => candidate.id === threadId);
              return thread === undefined
                ? null
                : ({
                    ...thread,
                    archivedAt: null,
                    deletedAt: null,
                  } as unknown as OrchestrationV2AppThread);
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (send) =>
            Effect.sync(() => {
              world.sent.push(send);
              return {
                delivery: "queued",
              } as unknown as ThreadManagement.ThreadManagementSendResult;
            }),
        }),
        RepositoryIdentityResolver.layer,
      ),
    ),
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-comments-git-" })),
        Layer.provideMerge(VcsProcess.layer),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-comments-" })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const storePacket = Effect.fn("test.storePacket")(function* (
  packet: ReviewPacket,
  key: { readonly branch: string } = change,
) {
  const repository = yield* ReviewPackets.ReviewPacketRepository;
  yield* repository.put({
    key: { host: change.host, repository: change.repository, branch: key.branch },
    packet,
    receivedAt: packet.revision.recordedAt,
    keepRevisions: 20,
  });
  // The files the agent is pointed at, as intake would have stored them.
  const fs = yield* FileSystem.FileSystem;
  const packets = yield* ReviewPacketService.ReviewPacketService;
  const { reviewMediaDir } = yield* ServerConfig.ServerConfig;
  yield* fs.makeDirectory(reviewMediaDir, { recursive: true });
  for (const entry of packet.media) yield* fs.writeFileString(packets.mediaPath(entry.id), "file");
});

const seedThread = Effect.fn("test.seedThread")(function* (thread: {
  readonly id: string;
  readonly projectId: string;
  readonly branch: string | null;
  readonly updatedAt: string;
  readonly pullRequest?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({
    branch: thread.branch,
    pullRequests:
      thread.pullRequest === undefined
        ? []
        : [
            {
              host: "github.com",
              repository: "acme/app",
              number: thread.pullRequest,
              source: "manual",
              linkedAt: thread.updatedAt,
              snapshot: null,
              stack: null,
            },
          ],
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${thread.id}, ${thread.projectId}, ${`Thread ${thread.id}`}, 'codex', 'full-access',
      'default', ${thread.updatedAt}, ${thread.updatedAt}, ${payload}
    )
  `;
});

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => ("reason" in error ? error.reason : error._tag)),
  );

const OWNER = ThreadId.make("thread-owner");

describe("ReviewCommentService", () => {
  it.effect(
    "a comment is pending until sent, open or answered by who spoke last, and resolved only by a person",
    () => {
      const world = makeWorld();
      const { sent } = world;
      return Effect.gen(function* () {
        const { workspace, base, head } = yield* makeRepositories({ clone: "head" });
        world.workspace = workspace;
        world.threads.push({ id: OWNER, projectId, branch: change.branch });
        yield* storePacket(
          packetAt({ base, head, recordedAt: "2026-11-01T00:00:00Z", latest: false }),
        );
        yield* seedThread({
          id: OWNER,
          projectId,
          branch: change.branch,
          updatedAt: "2026-11-01T00:00:00Z",
        });
        const service = yield* ReviewCommentService.ReviewCommentService;
        const answer = (kind: "fixed" | "answered" | "disagrees", fixedIn?: string) =>
          service.answer({
            threadId: OWNER,
            commentId: created.id,
            kind,
            text: `It is ${kind}.`,
            fixedIn,
          });
        const stateOf = Effect.map(service.list(change), (result) => ({
          state: result.comments[0]?.state,
          counts: result.counts,
        }));

        const created = (yield* service.create({
          ...change,
          anchor: { kind: "claim", packetHead: head, claimId: "smelt" },
          text: "Show a bar coming out.",
        })).comment!;
        expect(created.state).toBe("pending");
        expect(yield* refusal(answer("answered"))).toBe("pending");
        expect(yield* refusal(service.reply({ commentId: created.id, text: "And?" }))).toBe(
          "not-sent-yet",
        );
        const root = created.entries[0]!;
        yield* service.edit({ commentId: created.id, entryId: root.id, text: "Show one bar." });

        const delivered = yield* service.send(change);
        expect(delivered).toMatchObject({ _tag: "sent", threadId: OWNER, comments: 1, entries: 1 });
        expect(
          sent.map(({ threadId, mode, createdBy, creationSource }) => ({
            threadId,
            mode,
            createdBy,
            creationSource,
          })),
        ).toEqual([{ threadId: OWNER, mode: "queue", createdBy: "user", creationSource: "web" }]);
        expect(sent[0]!.text).toContain("Show one bar.");
        expect(yield* stateOf).toMatchObject({ state: "open", counts: { open: 1, unsent: 0 } });
        expect(
          yield* refusal(service.edit({ commentId: created.id, entryId: root.id, text: "x" })),
        ).toBe("entry-sent");
        expect(yield* service.send(change)).toEqual({ _tag: "nothing-to-send" });

        expect(yield* refusal(answer("fixed"))).toBe("fixed-needs-commit");
        expect((yield* answer("fixed", head.slice(0, 12))).comment?.state).toBe("answered");
        expect(sent).toHaveLength(1);

        // A follow-up waits for the next send; until then the agent's answer is the last word.
        yield* service.reply({ commentId: created.id, text: "The bar is the wrong colour." });
        expect(yield* stateOf).toMatchObject({ state: "answered", counts: { unsent: 1 } });
        yield* service.send(change);
        expect(yield* stateOf).toMatchObject({ state: "open", counts: { unsent: 0 } });
        expect((yield* answer("disagrees")).comment?.state).toBe("answered");
        expect((yield* answer("answered")).comment?.state).toBe("answered");

        expect(
          (yield* service.setResolved({ commentId: created.id, resolved: true })).comment?.state,
        ).toBe("resolved");
        expect(yield* refusal(answer("answered"))).toBe("resolved");
        // A person's follow-up reopens it, and the agent sees it once it is sent.
        yield* service.reply({ commentId: created.id, text: "One more thing." });
        yield* service.send(change);
        expect(yield* stateOf).toMatchObject({ state: "open", counts: { resolved: 0, open: 1 } });

        // Only the thread that owns the change answers it.
        expect(
          yield* refusal(
            service.answer({
              threadId: ThreadId.make("thread-stranger"),
              commentId: created.id,
              kind: "answered",
              text: "Not mine.",
            }),
          ),
        ).toBe("not-this-thread");

        const draft = (yield* service.create({
          ...change,
          anchor: { kind: "claim", packetHead: head, claimId: "trade-in-world" },
          text: "Never mind.",
        })).comment!;
        expect(yield* refusal(service.setResolved({ commentId: draft.id, resolved: true }))).toBe(
          "resolve-unsent",
        );
        expect(
          yield* service.remove({ commentId: draft.id, entryId: draft.entries[0]!.id }),
        ).toEqual({ comment: null });
        expect((yield* service.list(change)).comments.map((comment) => comment.id)).toEqual([
          created.id,
        ]);
      }).pipe(Effect.provide(harness(world)), Effect.scoped);
    },
  );

  it.effect(
    "a comment is outdated once the latest packet lacks its claim, image, clip or file, and a clip re-cut from the same recording keeps its range",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const { workspace, base, head, next } = yield* makeRepositories({ clone: "head" });
        world.workspace = workspace;
        yield* storePacket(
          packetAt({ base, head, recordedAt: "2026-11-01T00:00:00Z", latest: false }),
        );
        const service = yield* ReviewCommentService.ReviewCommentService;
        const anchors: ReadonlyArray<ReviewCommentAnchorInput> = [
          { kind: "claim", packetHead: head, claimId: "smelt" },
          { kind: "claim", packetHead: head, claimId: "trade-in-world" },
          { kind: "image-region", packetHead: head, media: IMAGE },
          // 12-15 s of the recording: 2-5 s of the first clip, 8-11 s of the re-cut one.
          { kind: "video-range", packetHead: head, media: CLIP, startMs: 2000, endMs: 5000 },
          {
            kind: "code-range",
            packetHead: head,
            path: "docs/notes.md",
            side: "new",
            startLine: 1,
            endLine: 1,
            commit: head,
          },
          {
            kind: "code-range",
            packetHead: head,
            path: "src/trade.ts",
            side: "new",
            startLine: 2,
            endLine: 3,
            commit: head,
          },
        ];
        for (const anchor of anchors) yield* service.create({ ...change, anchor, text: "Look." });
        const outdated = Effect.map(service.list(change), (result) =>
          result.comments.map(({ anchor, outdated, currentClip }) => ({
            kind: "kind" in anchor ? anchor.kind : "unknown",
            outdated,
            ...(currentClip === undefined ? {} : { currentClip }),
          })),
        );
        expect((yield* outdated).every((comment) => !comment.outdated)).toBe(true);

        yield* storePacket(
          packetAt({ base, head: next, recordedAt: "2026-11-02T00:00:00Z", latest: true }),
        );
        expect(yield* outdated).toEqual([
          { kind: "claim", outdated: true },
          { kind: "claim", outdated: false },
          { kind: "image-region", outdated: true },
          {
            kind: "video-range",
            outdated: false,
            currentClip: { media: RECUT, evidenceId: "recut", startMs: 8000, endMs: 11000 },
          },
          { kind: "code-range", outdated: true },
          { kind: "code-range", outdated: false },
        ]);
        expect((yield* service.list({ ...change, limit: 4 })).nextCursor).not.toBeNull();
      }).pipe(Effect.provide(harness(world)), Effect.scoped);
    },
  );

  it.effect(
    "send goes to the newest thread on the branch, else one linked to the pull request, else reports no owning thread",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const { workspace, base, head } = yield* makeRepositories({ clone: "head" });
        world.workspace = workspace;
        const service = yield* ReviewCommentService.ReviewCommentService;
        const pending = Effect.fn("test.pending")(function* (branch: string, pullRequest?: number) {
          const key = { ...change, branch };
          yield* storePacket(
            packetAt({
              base,
              head,
              recordedAt: "2026-11-01T00:00:00Z",
              latest: false,
              branch,
              ...(pullRequest === undefined ? {} : { pullRequest }),
            }),
            key,
          );
          yield* service.create({
            ...key,
            anchor: { kind: "claim", packetHead: head, claimId: "smelt" },
            text: "Show it.",
          });
          return key;
        });
        yield* seedThread({
          id: "older",
          projectId,
          branch: change.branch,
          updatedAt: "2026-11-01T00:00:00Z",
        });
        yield* seedThread({
          id: "newer",
          projectId,
          branch: change.branch,
          updatedAt: "2026-11-03T00:00:00Z",
        });
        // The same branch name in a project of another repository owns nothing here.
        yield* seedThread({
          id: "unrelated",
          projectId: otherProjectId,
          branch: change.branch,
          updatedAt: "2026-11-04T00:00:00Z",
        });
        yield* seedThread({
          id: "reviewer",
          projectId,
          branch: "main",
          updatedAt: "2026-11-02T00:00:00Z",
          pullRequest: 18,
        });

        const onBranch = yield* pending(change.branch);
        // The preview names the threads the send then chooses from.
        expect(yield* service.sendTarget(onBranch)).toMatchObject({
          candidates: [
            { threadId: "newer", match: "branch" },
            { threadId: "older", match: "branch" },
          ],
        });
        expect(yield* service.send(onBranch)).toMatchObject({
          _tag: "sent",
          threadId: "newer",
          candidates: [
            { threadId: "newer", match: "branch" },
            { threadId: "older", match: "branch" },
          ],
        });
        expect(yield* service.send(yield* pending("pushed-elsewhere", 18))).toMatchObject({
          _tag: "sent",
          threadId: "reviewer",
          candidates: [],
        });
        const orphan = yield* pending("orphan", 99);
        expect(yield* service.sendTarget(orphan)).toEqual({ candidates: [] });
        expect(yield* service.send(orphan)).toEqual({ _tag: "no-owning-thread", pullRequest: 99 });
        world.threads.push({ id: ThreadId.make("chosen"), projectId, branch: null });
        expect(
          yield* service.send({ ...orphan, threadId: ThreadId.make("chosen"), source: "mobile" }),
        ).toMatchObject({ _tag: "sent", threadId: "chosen" });
        expect(
          world.sent.map(({ threadId, mode, creationSource }) => [threadId, mode, creationSource]),
        ).toEqual([
          ["newer", "queue", "web"],
          ["reviewer", "queue", "web"],
          ["chosen", "queue", "mobile"],
        ]);
      }).pipe(Effect.provide(harness(world)), Effect.scoped);
    },
  );

  it.effect("the sent message says where each comment points and what it asks", () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const { root, workspace, base, head } = yield* makeRepositories({ clone: "head" });
      world.workspace = workspace;
      world.threads.push({ id: OWNER, projectId, branch: change.branch });
      yield* seedThread({
        id: OWNER,
        projectId,
        branch: change.branch,
        updatedAt: "2026-11-01T00:00:00Z",
      });
      yield* storePacket(
        packetAt({
          base,
          head,
          recordedAt: "2026-11-01T00:00:00Z",
          latest: false,
          pullRequest: 18,
        }),
      );
      const service = yield* ReviewCommentService.ReviewCommentService;
      const create = (anchor: ReviewCommentAnchorInput, text: string) =>
        service.create({ ...change, anchor, text });
      yield* create(
        { kind: "claim", packetHead: head, claimId: "smelt" },
        "Show a bar coming out.",
      );
      const code = (yield* create(
        {
          kind: "code-range",
          packetHead: head,
          claimId: "trade-in-world",
          path: "src/trade.ts",
          side: "new",
          startLine: 2,
          endLine: 3,
          commit: head,
        },
        "Name these after the vendor.",
      )).comment!;
      yield* create(
        {
          kind: "image-region",
          packetHead: head,
          claimId: "trade-in-world",
          media: IMAGE,
          region: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
        },
        "This button is clipped.",
      );
      yield* create(
        {
          kind: "video-range",
          packetHead: head,
          media: CLIP,
          startMs: 1500,
          endMs: 4250,
          region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        },
        "The trade window flickers here.",
      );
      yield* service.send(change);
      yield* service.answer({
        threadId: OWNER,
        commentId: code.id,
        kind: "fixed",
        text: "Renamed them.",
        fixedIn: head,
      });
      yield* service.reply({ commentId: code.id, text: "Also the third one." });
      yield* service.send(change);

      const { reviewMediaDir } = yield* ServerConfig.ServerConfig;
      const shown = world.sent.map((message) =>
        message.text
          .replaceAll(reviewMediaDir, "<media>")
          .replaceAll(root, "<root>")
          .replaceAll(head, "<head>")
          .replaceAll(head.slice(0, 12), "<head12>")
          .replace(/rc_[0-9a-f]{16}/gu, "rc_<id>"),
      );
      expect(shown[0]).toMatchInlineSnapshot(`
        "# Review comments

        The claims describe the change as it is today. Rewrite, split, merge or drop them whenever the change is better explained another way. A comment asks for an outcome; it does not ask for its claim to survive.

        Answer each comment by its id with the \`answer_review_comment\` tool: \`fixed\` with the commit the fix is in, \`answered\` when nothing needs to change, or \`disagrees\` with your reason. After a fix, re-run only the evidence the fix affects and submit a new packet. Never resolve a comment and never merge; the reviewer does both.

        Media files are named by their hash, without an extension; the type is in parentheses. Copy one to a name with that extension if a tool needs one.

        ## acme/app, branch trade-in-world (pull request #18)

        4 comments. The latest review packet is at <head>.

        ### Comment rc_<id>
        On claim "Smelt ores" (smelt)
        Statement: Ores smelt into bars.
        Comment:
          Reviewer:
            Show a bar coming out.

        ### Comment rc_<id>
        Under claim "Trade in world" (trade-in-world)
        Where: src/trade.ts, lines 2-3 of the new side, at <head12>
            2 | vendor 2
            3 | vendor 3
        Comment:
          Reviewer:
            Name these after the vendor.

        ### Comment rc_<id>
        Under claim "Trade in world" (trade-in-world)
        Where: image <media>/1111111111111111111111111111111111111111111111111111111111111111 (image/png), region x 0.100-0.500, y 0.200-0.400 as fractions of the width and height (pixels x 128-640, y 144-288 of 1280x720)
        Comment:
          Reviewer:
            This button is clipped.

        ### Comment rc_<id>
        Where: clip <media>/2222222222222222222222222222222222222222222222222222222222222222 (video/mp4), 1.500 s to 4.250 s of the clip; 11.500 s to 14.250 s of the recording sha256:3333333333333333333333333333333333333333333333333333333333333333; region x 0.500-1.000, y 0.500-1.000 as fractions of the width and height
        Comment:
          Reviewer:
            The trade window flickers here."
      `);
      expect(shown[1]).toMatchInlineSnapshot(`
        "# Review comments

        The claims describe the change as it is today. Rewrite, split, merge or drop them whenever the change is better explained another way. A comment asks for an outcome; it does not ask for its claim to survive.

        Answer each comment by its id with the \`answer_review_comment\` tool: \`fixed\` with the commit the fix is in, \`answered\` when nothing needs to change, or \`disagrees\` with your reason. After a fix, re-run only the evidence the fix affects and submit a new packet. Never resolve a comment and never merge; the reviewer does both.

        ## acme/app, branch trade-in-world (pull request #18)

        1 comment. The latest review packet is at <head>.

        ### Comment rc_<id>
        Under claim "Trade in world" (trade-in-world)
        Where: src/trade.ts, lines 2-3 of the new side, at <head12>
            2 | vendor 2
            3 | vendor 3
        Earlier:
          Reviewer:
            Name these after the vendor.
          You (fixed in <head12>):
            Renamed them.
        Now:
          Reviewer:
            Also the third one."
      `);
      // The agent's own read renders every open comment the same way.
      const read = yield* service.forThread(OWNER);
      expect(read.comments).toBe(4);
      expect(read.text).toContain(world.sent[1]!.text.split("### ")[1]!.trim());
    }).pipe(Effect.provide(harness(world)), Effect.scoped);
  });

  it.effect(
    "the recorded diff covers the packet's own range for the given paths, fetching commits the checkout lacks",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const { workspace, base, head } = yield* makeRepositories({ clone: "base" });
        world.workspace = workspace;
        yield* storePacket(
          packetAt({ base, head, recordedAt: "2026-11-01T00:00:00Z", latest: false }),
        );
        const service = yield* ReviewCommentService.ReviewCommentService;
        const diff = yield* service.recordedDiff({ ...change, head, paths: ["src/"] });
        expect(diff).toMatchObject({ _tag: "available", base, head, truncated: false });
        const patch = diff._tag === "available" ? diff.patch : "";
        expect(patch).toContain("diff --git a/src/trade.ts b/src/trade.ts");
        expect(patch).toContain("+vendor 2");
        expect(patch).not.toContain("docs/notes.md");
        expect(yield* service.recordedDiff({ ...change, head: "f".repeat(40), paths: [] })).toEqual(
          { _tag: "unavailable", reason: "packet-not-found" },
        );
        world.workspace = `${workspace}-gone`;
        expect(yield* service.recordedDiff({ ...change, head, paths: [] })).toEqual({
          _tag: "unavailable",
          reason: "no-checkout",
        });
      }).pipe(Effect.provide(harness(world)), Effect.scoped);
    },
  );
});
