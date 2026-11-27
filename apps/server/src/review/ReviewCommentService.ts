import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  CommandId,
  MessageId,
  REVIEW_COMMENT_LIMITS,
  ReviewCommentRefusedError,
  ReviewCommentSendError,
  ReviewCommentStoreError,
  findClipEvidence,
  isUnknownUnionMember,
  locateVideoRange,
  type ReviewCommentAnchorInput,
  type ReviewCommentAnswerKind,
  type ReviewCommentCreateInput,
  type ReviewCommentDeleteInput,
  type ReviewCommentEditInput,
  type ReviewCommentListInput,
  type ReviewCommentListResult,
  type ReviewCommentMutationResult,
  type ReviewCommentReplyInput,
  type ReviewCommentSendInput,
  type ReviewCommentSendResult,
  type ReviewCommentSetResolvedInput,
  type ReviewCommentThread,
  type ReviewCommentThreadCandidate,
  type ReviewPacket,
  type ReviewPacketChangeRef,
  type ReviewPacketRecordedDiffInput,
  type ReviewPacketRecordedDiffResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ReviewComments from "../persistence/ReviewComments.ts";
import * as ReviewPackets from "../persistence/ReviewPackets.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { listLinkedPullRequestThreads } from "../pullRequest/linkedThreads.ts";
import { ownPullRequestRepositories } from "../pullRequest/pullRequestSyncKey.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { REVIEW_DIFF_ARGS } from "../vcs/GitVcsDriverCore.ts";
import { listBranchThreads } from "./owningThreads.ts";
import * as ReviewPacketService from "./ReviewPacketService.ts";
import {
  renderReviewComments,
  type AgentVisibleEntry,
  type ReviewChangeForAgent,
  type ReviewCommentForAgent,
} from "./reviewCommentMessage.ts";
import {
  deliveredEntries,
  deriveReviewCommentState,
  sendableEntries,
  toWireEntry,
  type StoredReviewComment,
  type StoredReviewCommentEntry,
} from "./reviewCommentModel.ts";

const RECORDED_DIFF_MAX_BYTES = 1024 * 1024;
const EXCERPT_MAX_LINES = 40;
const EXCERPT_MAX_LINE_CHARS = 300;
const CHANGED_PATHS_CACHE_SIZE = 64;
const LIST_DEFAULT_LIMIT = 25;

type ChangeKey = ReviewPackets.ReviewPacketKey;

export interface ReviewThreadComments {
  readonly changes: ReadonlyArray<ChangeKey>;
  readonly comments: number;
  readonly text: string;
}

export class ReviewCommentService extends Context.Service<
  ReviewCommentService,
  {
    readonly list: (
      input: ReviewCommentListInput,
    ) => Effect.Effect<
      ReviewCommentListResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    /** A person's new comment; it stays pending until sent. */
    readonly create: (
      input: ReviewCommentCreateInput,
    ) => Effect.Effect<
      ReviewCommentMutationResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    readonly edit: (
      input: ReviewCommentEditInput,
    ) => Effect.Effect<
      ReviewCommentMutationResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    readonly remove: (
      input: ReviewCommentDeleteInput,
    ) => Effect.Effect<
      ReviewCommentMutationResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    readonly reply: (
      input: ReviewCommentReplyInput,
    ) => Effect.Effect<
      ReviewCommentMutationResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    /** Only a person resolves or reopens a comment. */
    readonly setResolved: (
      input: ReviewCommentSetResolvedInput,
    ) => Effect.Effect<
      ReviewCommentMutationResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    /** A person's send: every unsent entry of the change, queued to one thread as one message. */
    readonly send: (
      input: ReviewCommentSendInput,
    ) => Effect.Effect<
      ReviewCommentSendResult,
      ReviewCommentRefusedError | ReviewCommentStoreError | ReviewCommentSendError
    >;
    /** The open comments on the changes a thread owns, rendered as a send renders them. */
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReviewThreadComments, ReviewCommentStoreError>;
    /** An agent's answer from `threadId`; it never sends anything. */
    readonly answer: (input: {
      readonly threadId: ThreadId;
      readonly commentId: string;
      readonly kind: ReviewCommentAnswerKind;
      readonly text: string;
      readonly fixedIn?: string | undefined;
    }) => Effect.Effect<
      ReviewCommentMutationResult,
      ReviewCommentRefusedError | ReviewCommentStoreError
    >;
    readonly recordedDiff: (
      input: ReviewPacketRecordedDiffInput,
    ) => Effect.Effect<ReviewPacketRecordedDiffResult, ReviewCommentStoreError>;
  }
>()("t3/review/ReviewCommentService") {}

const keyOf = (change: ReviewPacketChangeRef): ChangeKey => ({
  host: change.host?.toLowerCase() ?? "",
  repository: change.repository.toLowerCase(),
  branch: change.branch,
});

const sameKey = (left: ChangeKey, right: ChangeKey) =>
  left.host === right.host && left.repository === right.repository && left.branch === right.branch;

const storeError = (operation: string) => (cause: unknown) =>
  new ReviewCommentStoreError({ operation, cause });

const refuse = (reason: ReviewCommentRefusedError["reason"]) =>
  Effect.fail(new ReviewCommentRefusedError({ reason }));

/** The page cursor is the last comment's creation position. */
const decodeCursor = (cursor: string | undefined) => {
  const position = cursor === undefined ? Number.NaN : Number(cursor);
  return Number.isSafeInteger(position) ? position : undefined;
};

const makeRandomHex = Effect.fn("ReviewCommentService.randomHex")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return (yield* random.uuidV4()).replaceAll("-", "").slice(0, 16);
});

/** The person's words the agent has not answered yet, and what came before them. */
const splitForAgent = (entries: ReadonlyArray<StoredReviewCommentEntry>) => {
  const lastAnswer = entries.findLastIndex((entry) => entry.author === "agent");
  const earlier = entries
    .slice(0, lastAnswer + 1)
    .map((entry): AgentVisibleEntry =>
      entry.author === "person"
        ? { author: "person", text: entry.text }
        : { author: "agent", kind: entry.kind, text: entry.text, fixedIn: entry.fixedIn },
    );
  const latest = entries.slice(lastAnswer + 1).map((entry) => entry.text);
  return { earlier, latest };
};

const make = Effect.gen(function* () {
  const comments = yield* ReviewComments.ReviewCommentRepository;
  const packets = yield* ReviewPackets.ReviewPacketRepository;
  const packetService = yield* ReviewPacketService.ReviewPacketService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const sql = yield* SqlClient.SqlClient;
  // Comments change by load, edit and store; one writer at a time keeps an answer and a reply
  // from overwriting each other.
  const writes = yield* Semaphore.make(1);
  const changedPathsCache = new Map<string, ReadonlySet<string>>();

  const randomId = makeRandomHex().pipe(Effect.provideService(SecureRandom.SecureRandom, random));
  const now = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  const latestPacket = Effect.fn("ReviewCommentService.latestPacket")(
    function* (key: ChangeKey) {
      const revisions = yield* packets.revisions(key);
      const head = revisions[0]?.head;
      return head === undefined ? null : Option.getOrNull(yield* packets.getPacket(key, head));
    },
    Effect.mapError(storeError("latestPacket")),
  );

  /** The project checkouts of the change's repository; their worktrees share its objects. */
  const checkoutsOf = Effect.fn("ReviewCommentService.checkoutsOf")(function* (key: ChangeKey) {
    const shells = yield* projects.listShells().pipe(Effect.mapError(storeError("projects")));
    const roots: Array<{ readonly projectId: ProjectId; readonly workspaceRoot: string }> = [];
    for (const shell of shells) {
      const identity = yield* identities.resolve(shell.workspaceRoot);
      const owns = ownPullRequestRepositories(identity).some(
        (candidate) =>
          candidate.key.repository === key.repository &&
          (key.host === "" || candidate.key.host === key.host),
      );
      if (owns) roots.push({ projectId: shell.id, workspaceRoot: shell.workspaceRoot });
    }
    return roots;
  });

  const hasCommit = (cwd: string, sha: string) =>
    git
      .execute({
        operation: "ReviewCommentService.hasCommit",
        cwd,
        args: ["cat-file", "-e", `${sha}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => false),
      );

  /** Fetches what is missing by sha from the primary remote, which forges allow for reachable commits. */
  const ensureCommits = Effect.fn("ReviewCommentService.ensureCommits")(function* (
    cwd: string,
    shas: ReadonlyArray<string>,
  ) {
    for (const sha of shas) {
      if (yield* hasCommit(cwd, sha)) continue;
      yield* git.fetchRefCommit({ cwd, ref: sha }).pipe(Effect.ignore);
      if (!(yield* hasCommit(cwd, sha))) return false;
    }
    return true;
  });

  const checkoutWith = Effect.fn("ReviewCommentService.checkoutWith")(function* (
    key: ChangeKey,
    shas: ReadonlyArray<string>,
    options: { readonly fetch: boolean },
  ) {
    const checkouts = yield* checkoutsOf(key);
    for (const checkout of checkouts) {
      const present = options.fetch
        ? yield* ensureCommits(checkout.workspaceRoot, shas)
        : yield* Effect.forEach(shas, (sha) => hasCommit(checkout.workspaceRoot, sha)).pipe(
            Effect.map((found) => found.every(Boolean)),
          );
      if (present) return { found: true as const, cwd: checkout.workspaceRoot };
    }
    return { found: false as const, anyCheckout: checkouts.length > 0 };
  });

  /** Every path the packet's range touches, old names of renames included; null when unknown. */
  const changedPaths = Effect.fn("ReviewCommentService.changedPaths")(function* (
    key: ChangeKey,
    packet: ReviewPacket,
  ) {
    const { base, head } = packet.revision;
    const cacheKey = `${key.host}|${key.repository}|${base}|${head}`;
    const cached = changedPathsCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const checkout = yield* checkoutWith(key, [base, head], { fetch: false });
    if (!checkout.found) return null;
    const result = yield* git
      .execute({
        operation: "ReviewCommentService.changedPaths",
        cwd: checkout.cwd,
        args: ["diff", "--name-only", "--no-renames", "-z", base, head],
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.option);
    if (Option.isNone(result) || result.value.stdoutTruncated) return null;
    const paths: ReadonlySet<string> = new Set(result.value.stdout.split("\0").filter(Boolean));
    if (changedPathsCache.size >= CHANGED_PATHS_CACHE_SIZE) {
      changedPathsCache.delete(changedPathsCache.keys().next().value!);
    }
    changedPathsCache.set(cacheKey, paths);
    return paths;
  });

  const outdatedOf = (
    comment: StoredReviewComment,
    latest: ReviewPacket | null,
    paths: ReadonlySet<string> | null,
  ) => {
    const anchor = comment.anchor;
    if (latest === null || isUnknownUnionMember(anchor)) return { outdated: false };
    switch (anchor.kind) {
      case "claim":
        return { outdated: !latest.claims.some((claim) => claim.id === anchor.claimId) };
      case "image-region":
        return { outdated: !latest.media.some((media) => media.id === anchor.media) };
      case "video-range": {
        const located = locateVideoRange(latest, anchor);
        return located === null ? { outdated: true } : { outdated: false, currentClip: located };
      }
      case "code-range":
        return { outdated: paths !== null && !paths.has(anchor.path) };
    }
  };

  const toThread = (
    comment: StoredReviewComment,
    latest: ReviewPacket | null,
    paths: ReadonlySet<string> | null,
  ): ReviewCommentThread => ({
    id: comment.id,
    anchor: comment.anchor,
    state: deriveReviewCommentState(comment),
    ...outdatedOf(comment, latest, paths),
    entries: comment.entries.map(toWireEntry),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    resolvedAt: comment.resolvedAt,
  });

  const describe = Effect.fn("ReviewCommentService.describe")(function* (
    key: ChangeKey,
    stored: ReadonlyArray<StoredReviewComment>,
  ) {
    const latest = yield* latestPacket(key);
    const needsPaths =
      latest !== null &&
      stored.some(
        (comment) => !isUnknownUnionMember(comment.anchor) && comment.anchor.kind === "code-range",
      );
    const paths = needsPaths ? yield* changedPaths(key, latest) : null;
    return { latest, threads: stored.map((comment) => toThread(comment, latest, paths)) };
  });

  const mutationResult = Effect.fn("ReviewCommentService.mutationResult")(function* (
    comment: StoredReviewComment | null,
  ) {
    yield* packetService.notifyChanged;
    if (comment === null) return { comment: null };
    const { threads } = yield* describe(comment, [comment]);
    return { comment: threads[0]! };
  });

  const load = Effect.fn("ReviewCommentService.load")(function* (commentId: string) {
    const found = yield* comments.get(commentId).pipe(Effect.mapError(storeError("load")));
    return Option.isSome(found) ? found.value : yield* refuse("comment-not-found");
  });

  /** Checks the anchor against the packet it names and fills in what the server derives. */
  const checkAnchor = Effect.fn("ReviewCommentService.checkAnchor")(function* (
    key: ChangeKey,
    anchor: ReviewCommentAnchorInput,
  ) {
    const packet = Option.getOrUndefined(
      yield* packets.getPacket(key, anchor.packetHead).pipe(Effect.mapError(storeError("packet"))),
    );
    if (packet === undefined) return yield* refuse("packet-not-found");
    const hasClaim = (id: string) => packet.claims.some((claim) => claim.id === id);
    if (anchor.claimId !== undefined && !hasClaim(anchor.claimId)) {
      return yield* refuse("anchor-not-in-packet");
    }
    switch (anchor.kind) {
      case "claim":
      case "code-range":
        return anchor;
      case "image-region": {
        const media = packet.media.find((entry) => entry.id === anchor.media);
        return media?.type.startsWith("image/") === true
          ? anchor
          : yield* refuse("anchor-not-in-packet");
      }
      case "video-range": {
        const clip = findClipEvidence(packet, anchor.media);
        if (clip === undefined || anchor.endMs > clip.endMs - clip.startMs) {
          return yield* refuse("anchor-not-in-packet");
        }
        const { recording: _sent, ...rest } = anchor;
        return clip.recording === undefined
          ? rest
          : {
              ...rest,
              recording: {
                media: clip.recording,
                startMs: clip.startMs + anchor.startMs,
                endMs: clip.startMs + anchor.endMs,
              },
            };
      }
    }
  });

  const assertRoomForUnsent = Effect.fn("ReviewCommentService.assertRoomForUnsent")(function* (
    key: ChangeKey,
  ) {
    const counts = yield* comments.counts(key).pipe(Effect.mapError(storeError("counts")));
    if (counts.unsent >= REVIEW_COMMENT_LIMITS.unsentPerChange) {
      return yield* refuse("too-many-unsent");
    }
  });

  const personEntry = Effect.fn("ReviewCommentService.personEntry")(function* (text: string) {
    const at = yield* now;
    return {
      id: `re_${yield* randomId}`,
      author: "person" as const,
      text,
      createdAt: at,
      updatedAt: at,
      sentAt: null,
      sentToThreadId: null,
      messageId: null,
    };
  });

  const update = Effect.fn("ReviewCommentService.update")(function* (comment: StoredReviewComment) {
    yield* comments.update(comment).pipe(Effect.mapError(storeError("update")));
    return yield* mutationResult(comment);
  });

  const create: ReviewCommentService["Service"]["create"] = Effect.fn(
    "ReviewCommentService.create",
  )(function* (input) {
    const key = keyOf(input);
    const anchor = yield* checkAnchor(key, input.anchor);
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        yield* assertRoomForUnsent(key);
        const root = yield* personEntry(input.text);
        const comment = {
          id: `rc_${yield* randomId}`,
          ...key,
          anchor,
          entries: [root],
          createdAt: root.createdAt,
          updatedAt: root.createdAt,
          resolvedAt: null,
        };
        yield* comments.insert(comment).pipe(Effect.mapError(storeError("insert")));
        return yield* mutationResult(comment);
      }),
    );
  });

  const unsentEntryOf = Effect.fn("ReviewCommentService.unsentEntryOf")(function* (
    comment: StoredReviewComment,
    entryId: string,
  ) {
    const index = comment.entries.findIndex((entry) => entry.id === entryId);
    const entry = comment.entries[index];
    if (entry === undefined) return yield* refuse("entry-not-found");
    if (entry.author !== "person" || entry.sentAt !== null) return yield* refuse("entry-sent");
    return { index, entry };
  });

  const edit: ReviewCommentService["Service"]["edit"] = Effect.fn("ReviewCommentService.edit")(
    function* (input) {
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const comment = yield* load(input.commentId);
          const { index, entry } = yield* unsentEntryOf(comment, input.entryId);
          const at = yield* now;
          const entries = comment.entries.with(index, {
            ...entry,
            text: input.text,
            updatedAt: at,
          });
          return yield* update({ ...comment, entries, updatedAt: at });
        }),
      );
    },
  );

  const remove: ReviewCommentService["Service"]["remove"] = Effect.fn(
    "ReviewCommentService.remove",
  )(function* (input) {
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const comment = yield* load(input.commentId);
        const { index } = yield* unsentEntryOf(comment, input.entryId);
        if (index === 0) {
          yield* comments.remove(comment.id).pipe(Effect.mapError(storeError("remove")));
          return yield* mutationResult(null);
        }
        return yield* update({
          ...comment,
          entries: comment.entries.toSpliced(index, 1),
          updatedAt: yield* now,
        });
      }),
    );
  });

  const reply: ReviewCommentService["Service"]["reply"] = Effect.fn("ReviewCommentService.reply")(
    function* (input) {
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const comment = yield* load(input.commentId);
          if (deriveReviewCommentState(comment) === "pending") return yield* refuse("not-sent-yet");
          if (comment.entries.length >= REVIEW_COMMENT_LIMITS.entriesPerComment) {
            return yield* refuse("too-many-entries");
          }
          yield* assertRoomForUnsent(comment);
          const entry = yield* personEntry(input.text);
          return yield* update({
            ...comment,
            entries: [...comment.entries, entry],
            updatedAt: entry.createdAt,
            resolvedAt: null,
          });
        }),
      );
    },
  );

  const setResolved: ReviewCommentService["Service"]["setResolved"] = Effect.fn(
    "ReviewCommentService.setResolved",
  )(function* (input) {
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const comment = yield* load(input.commentId);
        if (deriveReviewCommentState(comment) === "pending") return yield* refuse("resolve-unsent");
        if ((comment.resolvedAt !== null) === input.resolved) return yield* mutationResult(comment);
        const at = yield* now;
        return yield* update({
          ...comment,
          resolvedAt: input.resolved ? at : null,
          updatedAt: at,
        });
      }),
    );
  });

  /** Owning threads by branch, then by the change's pull request, most recently active first. */
  const owningThreads = Effect.fn("ReviewCommentService.owningThreads")(function* (
    key: ChangeKey,
    pullRequest: number | null,
  ) {
    const onBranch = yield* listBranchThreads(key.branch).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(storeError("branchThreads")),
    );
    const projectIds = new Set(
      (yield* checkoutsOf(key).pipe(Effect.mapError(storeError("checkouts")))).map(
        (checkout) => checkout.projectId,
      ),
    );
    const byBranch = onBranch
      .filter((thread) => projectIds.has(thread.projectId))
      .map((thread): ReviewCommentThreadCandidate => ({
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        match: "branch",
      }));
    if (byBranch.length > 0 || pullRequest === null || key.host === "") return byBranch;
    const linked = yield* listLinkedPullRequestThreads({
      host: key.host,
      repository: key.repository,
      number: pullRequest,
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(storeError("linkedThreads")),
    );
    return linked.threads
      .filter((thread) => thread.archivedAt === null)
      .map((thread): ReviewCommentThreadCandidate => ({
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        match: "pull-request",
      }));
  });

  const mediaFile = Effect.fn("ReviewCommentService.mediaFile")(function* (
    packet: ReviewPacket | null,
    media: string,
  ) {
    const entry = packet?.media.find((candidate) => candidate.id === media);
    const path = packetService.mediaPath(media);
    const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
    return {
      media,
      path: exists ? path : null,
      type: entry?.type ?? null,
      width: entry?.width ?? null,
      height: entry?.height ?? null,
    };
  });

  const excerptOf = Effect.fn("ReviewCommentService.excerpt")(function* (
    key: ChangeKey,
    anchor: {
      readonly commit: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    },
  ) {
    const checkout = yield* checkoutWith(key, [anchor.commit], { fetch: false });
    if (!checkout.found) return null;
    const shown = yield* git
      .execute({
        operation: "ReviewCommentService.excerpt",
        cwd: checkout.cwd,
        args: ["show", `${anchor.commit}:${anchor.path}`],
        maxOutputBytes: 4 * 1024 * 1024,
        allowNonZeroExit: true,
      })
      .pipe(Effect.option);
    if (Option.isNone(shown) || shown.value.exitCode !== 0) return null;
    const last = Math.min(anchor.endLine, anchor.startLine + EXCERPT_MAX_LINES - 1);
    return shown.value.stdout
      .split("\n")
      .slice(anchor.startLine - 1, last)
      .map((text, offset) => ({
        line: anchor.startLine + offset,
        text:
          text.length > EXCERPT_MAX_LINE_CHARS ? `${text.slice(0, EXCERPT_MAX_LINE_CHARS)}…` : text,
      }));
  });

  /** Looks up what the agent needs to act on each comment: titles, files, excerpts, the latest packet. */
  const forAgent = Effect.fn("ReviewCommentService.forAgent")(function* (
    key: ChangeKey,
    stored: ReadonlyArray<{
      readonly comment: StoredReviewComment;
      readonly visible: ReadonlyArray<StoredReviewCommentEntry>;
    }>,
  ) {
    const { latest, threads } = yield* describe(
      key,
      stored.map(({ comment }) => comment),
    );
    const packetCache = new Map<string, ReviewPacket | null>();
    const packetAt = Effect.fn("ReviewCommentService.packetAt")(function* (head: string) {
      if (packetCache.has(head)) return packetCache.get(head)!;
      const packet = Option.getOrNull(
        yield* packets.getPacket(key, head).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      packetCache.set(head, packet);
      return packet;
    });
    const rendered: Array<ReviewCommentForAgent> = [];
    for (const [index, { comment, visible }] of stored.entries()) {
      const thread = threads[index]!;
      const anchor = comment.anchor;
      const { earlier, latest: words } = splitForAgent(visible);
      if (isUnknownUnionMember(anchor)) {
        rendered.push({
          id: comment.id,
          where: { kind: "unknown", anchorKind: anchor.value },
          outdated: false,
          earlier,
          latest: words,
        });
        continue;
      }
      const made = (yield* packetAt(anchor.packetHead)) ?? latest;
      const claimOf = (id: string) => {
        const claim =
          made?.claims.find((candidate) => candidate.id === id) ??
          latest?.claims.find((candidate) => candidate.id === id);
        return { id, title: claim?.title ?? null, statement: claim?.statement ?? null };
      };
      const claim = anchor.claimId === undefined ? undefined : claimOf(anchor.claimId);
      const where: ReviewCommentForAgent["where"] = yield* Effect.gen(function* () {
        switch (anchor.kind) {
          case "claim":
            return { kind: "claim" as const, statement: claim?.statement ?? null };
          case "code-range":
            return {
              kind: "code-range" as const,
              path: anchor.path,
              side: anchor.side,
              startLine: anchor.startLine,
              endLine: anchor.endLine,
              commit: anchor.commit,
              excerpt: yield* excerptOf(key, anchor),
            };
          case "image-region":
            return {
              kind: "image-region" as const,
              file: yield* mediaFile(made, anchor.media),
              region: anchor.region ?? null,
            };
          case "video-range": {
            const recording = anchor.recording;
            const current = thread.currentClip;
            const recordingPath =
              recording === undefined ? null : (yield* mediaFile(null, recording.media)).path;
            return {
              kind: "video-range" as const,
              file: yield* mediaFile(made, anchor.media),
              startMs: anchor.startMs,
              endMs: anchor.endMs,
              recording: recording === undefined ? null : { ...recording, path: recordingPath },
              region: anchor.region ?? null,
              recut:
                current === undefined || current.media === anchor.media
                  ? null
                  : { ...current, path: (yield* mediaFile(latest, current.media)).path },
            };
          }
        }
      });
      rendered.push({
        id: comment.id,
        ...(claim === undefined ? {} : { claim: { id: claim.id, title: claim.title } }),
        where,
        outdated: thread.outdated,
        earlier,
        latest: words,
      });
    }
    return { latest, rendered };
  });

  const changeForAgent = Effect.fn("ReviewCommentService.changeForAgent")(function* (
    key: ChangeKey,
    stored: ReadonlyArray<{
      readonly comment: StoredReviewComment;
      readonly visible: ReadonlyArray<StoredReviewCommentEntry>;
    }>,
  ) {
    const { latest, rendered } = yield* forAgent(key, stored);
    return {
      repository: key.repository,
      branch: key.branch,
      pullRequest: latest?.change.pullRequest ?? null,
      latestHead: latest?.revision.head ?? null,
      comments: rendered,
    } satisfies ReviewChangeForAgent;
  });

  const send: ReviewCommentService["Service"]["send"] = Effect.fn("ReviewCommentService.send")(
    function* (input) {
      const key = keyOf(input);
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const waiting = (yield* comments
            .list(key, { withUnsent: true })
            .pipe(Effect.mapError(storeError("unsent")))).filter(
            (comment) => sendableEntries(comment).length > 0,
          );
          if (waiting.length === 0) return { _tag: "nothing-to-send" as const };
          const latest = yield* latestPacket(key).pipe(Effect.mapError(storeError("packet")));
          const pullRequest = latest?.change.pullRequest ?? null;

          let target: { readonly threadId: ThreadId; readonly projectId: ProjectId };
          let candidates: ReadonlyArray<ReviewCommentThreadCandidate> = [];
          if (input.threadId !== undefined) {
            const thread = yield* projections
              .findThread(input.threadId)
              .pipe(Effect.mapError(storeError("thread")));
            if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) {
              return yield* refuse("thread-not-found");
            }
            target = { threadId: thread.id, projectId: thread.projectId };
          } else {
            candidates = yield* owningThreads(key, pullRequest);
            const first = candidates[0];
            if (first === undefined) {
              return { _tag: "no-owning-thread" as const, pullRequest };
            }
            target = first;
          }

          const change = yield* changeForAgent(
            key,
            // Everything on a comment that is not resolved is delivered or about to be.
            waiting.map((comment) => ({ comment, visible: comment.entries })),
          ).pipe(Effect.mapError(storeError("render")));
          const id = yield* randomId;
          const messageId = MessageId.make(`message:review-comments:${id}`);
          const sent = yield* threads
            .sendToThread({
              projectId: target.projectId,
              commandId: CommandId.make(`command:review-comments:${id}`),
              threadId: target.threadId,
              messageId,
              text: renderReviewComments([change]),
              attachments: [],
              // Queued behind a running turn, never steered into it, as a watcher wake is.
              mode: "queue",
              createdBy: "user",
              creationSource: input.source ?? "web",
            })
            .pipe(
              Effect.mapError(
                (cause) => new ReviewCommentSendError({ threadId: target.threadId, cause }),
              ),
            );
          const at = yield* now;
          let entryCount = 0;
          for (const comment of waiting) {
            const entries = comment.entries.map((entry) => {
              if (entry.author !== "person" || entry.sentAt !== null) return entry;
              entryCount += 1;
              return { ...entry, sentAt: at, sentToThreadId: target.threadId, messageId };
            });
            yield* comments
              .update({ ...comment, entries, updatedAt: at })
              .pipe(Effect.mapError(storeError("markSent")));
          }
          yield* packetService.notifyChanged;
          return {
            _tag: "sent" as const,
            threadId: target.threadId,
            messageId,
            comments: waiting.length,
            entries: entryCount,
            delivery: sent.delivery === "started" ? ("started" as const) : ("queued" as const),
            candidates: candidates.length > 1 ? candidates : [],
          };
        }),
      );
    },
  );

  /** The changes a thread owns: its branch in its project's repository, and any it was sent. */
  const changesOfThread = Effect.fn("ReviewCommentService.changesOfThread")(function* (
    threadId: ThreadId,
  ) {
    const keys: Array<ChangeKey> = [
      ...(yield* comments.changesOfThread(threadId).pipe(Effect.mapError(storeError("changes")))),
    ];
    const thread = yield* projections
      .findThread(threadId)
      .pipe(Effect.mapError(storeError("thread")));
    if (thread?.branch != null) {
      const project = Option.getOrUndefined(
        yield* projects.getShell(thread.projectId).pipe(Effect.mapError(storeError("project"))),
      );
      const identity =
        project === undefined ? null : yield* identities.resolve(project.workspaceRoot);
      for (const { key } of ownPullRequestRepositories(identity)) {
        keys.push({ host: key.host, repository: key.repository, branch: thread.branch });
        keys.push({ host: "", repository: key.repository, branch: thread.branch });
      }
    }
    return keys.filter((key, index) => keys.findIndex((other) => sameKey(other, key)) === index);
  });

  const forThread: ReviewCommentService["Service"]["forThread"] = Effect.fn(
    "ReviewCommentService.forThread",
  )(function* (threadId) {
    const keys = yield* changesOfThread(threadId);
    const changes: Array<ReviewChangeForAgent> = [];
    const owned: Array<ChangeKey> = [];
    let count = 0;
    for (const key of keys) {
      // Oldest first and bounded, as one send is; answering them surfaces the rest.
      const open = yield* comments
        .list(key, { states: ["open"], limit: REVIEW_COMMENT_LIMITS.unsentPerChange })
        .pipe(Effect.mapError(storeError("open")));
      if (open.length === 0) continue;
      owned.push(key);
      count += open.length;
      changes.push(
        yield* changeForAgent(
          key,
          open.map((comment) => ({ comment, visible: deliveredEntries(comment.entries) })),
        ).pipe(Effect.mapError(storeError("render"))),
      );
    }
    return { changes: owned, comments: count, text: renderReviewComments(changes) };
  });

  const answer: ReviewCommentService["Service"]["answer"] = Effect.fn(
    "ReviewCommentService.answer",
  )(function* (input) {
    if (input.kind === "fixed" && input.fixedIn === undefined) {
      return yield* refuse("fixed-needs-commit");
    }
    const owned = yield* changesOfThread(input.threadId);
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const comment = yield* load(input.commentId);
        if (!owned.some((key) => sameKey(key, comment))) return yield* refuse("not-this-thread");
        const state = deriveReviewCommentState(comment);
        if (state === "pending" || state === "resolved") return yield* refuse(state);
        if (comment.entries.length >= REVIEW_COMMENT_LIMITS.entriesPerComment) {
          return yield* refuse("too-many-entries");
        }
        const at = yield* now;
        return yield* update({
          ...comment,
          entries: [
            ...comment.entries,
            {
              id: `re_${yield* randomId}`,
              author: "agent",
              kind: input.kind,
              text: input.text,
              fixedIn: input.fixedIn ?? null,
              threadId: input.threadId,
              createdAt: at,
            },
          ],
          updatedAt: at,
        });
      }),
    );
  });

  const list: ReviewCommentService["Service"]["list"] = Effect.fn("ReviewCommentService.list")(
    function* (input) {
      const key = keyOf(input);
      const limit = input.limit ?? LIST_DEFAULT_LIMIT;
      const after = decodeCursor(input.cursor);
      const page = yield* comments
        .list(key, {
          ...(input.states === undefined ? {} : { states: input.states }),
          ...(after === undefined ? {} : { after }),
          limit: limit + 1,
        })
        .pipe(Effect.mapError(storeError("list")));
      const shown = page.slice(0, limit);
      const counts = yield* comments.counts(key).pipe(Effect.mapError(storeError("counts")));
      const { latest, threads: described } = yield* describe(key, shown).pipe(
        Effect.mapError(storeError("describe")),
      );
      return {
        comments: described,
        nextCursor: page.length > limit ? String(shown.at(-1)!.position) : null,
        counts,
        latestHead: latest?.revision.head ?? null,
      };
    },
  );

  const recordedDiff: ReviewCommentService["Service"]["recordedDiff"] = Effect.fn(
    "ReviewCommentService.recordedDiff",
  )(function* (input) {
    const key = keyOf(input);
    const packet = Option.getOrUndefined(
      yield* packets.getPacket(key, input.head).pipe(Effect.mapError(storeError("packet"))),
    );
    if (packet === undefined) return { _tag: "unavailable", reason: "packet-not-found" } as const;
    const { base, head } = packet.revision;
    const checkout = yield* checkoutWith(key, [base, head], { fetch: true }).pipe(
      Effect.mapError(storeError("checkout")),
    );
    if (!checkout.found) {
      return {
        _tag: "unavailable",
        reason: checkout.anyCheckout ? "commits-missing" : "no-checkout",
      } as const;
    }
    const result = yield* git
      .execute({
        operation: "ReviewCommentService.recordedDiff",
        cwd: checkout.cwd,
        args: [...REVIEW_DIFF_ARGS, base, head, "--", ...input.paths],
        maxOutputBytes: RECORDED_DIFF_MAX_BYTES,
      })
      .pipe(Effect.mapError(storeError("diff")));
    return {
      _tag: "available",
      base,
      head,
      patch: result.stdout,
      truncated: result.stdoutTruncated,
    } as const;
  });

  return ReviewCommentService.of({
    list,
    create,
    edit,
    remove,
    reply,
    setResolved,
    send,
    forThread,
    answer,
    recordedDiff,
  });
});

export const layer = Layer.effect(ReviewCommentService, make);
