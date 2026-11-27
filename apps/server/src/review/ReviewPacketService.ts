import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ReviewPacketReadError,
  ReviewPacketStrict,
  findDanglingMediaReferences,
  type ReviewPacket,
  type ReviewPacketGetInput,
  type ReviewPacketGetResult,
  type ReviewPacketListInput,
  type ReviewPacketListResult,
  type ReviewPacketSubmitInput,
  type ReviewPacketSubmitResult,
} from "@t3tools/contracts";

import { openMediaFile } from "../assets/MediaFile.ts";
import * as ServerConfig from "../config.ts";
import * as ReviewPackets from "../persistence/ReviewPackets.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ownPullRequestRepositories } from "../pullRequest/pullRequestSyncKey.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { hashMediaFile } from "./reviewPacketMedia.ts";

/**
 * A manifest is sent whole to every client that opens the change, so it stays small: real
 * packets are about 10 KB. Media limits follow chat attachments (100 files, 10 MiB images,
 * 50 MiB other files), with a total so one packet cannot fill the disk.
 */
export const REVIEW_PACKET_LIMITS = {
  manifestBytes: 256 * 1024,
  claims: 50,
  evidencePerClaim: 20,
  findings: 50,
  media: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  imageBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  videoBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  totalMediaBytes: 256 * 1024 * 1024,
} as const;

export const REVIEW_PACKET_REVISIONS_PER_CHANGE = 20;

const LIST_DEFAULT_LIMIT = 50;

/** Served inline with the type the manifest states, so only types that never run script. */
const MEDIA_TYPES: Readonly<Record<string, "image" | "video">> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "video/mp4": "video",
  "video/webm": "video",
};

export const isServableReviewMediaType = (type: string) => MEDIA_TYPES[type] !== undefined;

export class ReviewPacketFolderError extends Schema.TaggedError<ReviewPacketFolderError>()(
  "ReviewPacketFolderError",
  { directory: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not read packet.json in the folder ${this.directory}.`;
  }
}

export class ReviewPacketInvalidError extends Schema.TaggedError<ReviewPacketInvalidError>()(
  "ReviewPacketInvalidError",
  { issue: Schema.String, at: Schema.optional(Schema.String) },
) {
  override get message(): string {
    const at = this.at === undefined || this.at === "" ? "" : ` (at ${this.at})`;
    return `packet.json is not a valid review packet: ${this.issue}${at}`;
  }
}

export class ReviewPacketLimitError extends Schema.TaggedError<ReviewPacketLimitError>()(
  "ReviewPacketLimitError",
  {
    limit: Schema.Literals([
      "manifestBytes",
      "claims",
      "evidencePerClaim",
      "findings",
      "media",
      "mediaBytes",
      "totalMediaBytes",
    ]),
    actual: Schema.Number,
    max: Schema.Number,
    mediaId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const what = {
      manifestBytes: "packet.json is",
      claims: "The packet has claims numbering",
      evidencePerClaim: "A claim has evidence items numbering",
      findings: "The packet's blockers or notes number",
      media: "The packet lists media files numbering",
      mediaBytes: `Media ${this.mediaId ?? ""} is`,
      totalMediaBytes: "The packet's media total",
    }[this.limit];
    const unit = this.limit.endsWith("Bytes") ? " bytes" : "";
    return `${what} ${this.actual}${unit}; the most T3 Code accepts is ${this.max}${unit}.`;
  }
}

export class ReviewPacketDanglingMediaError extends Schema.TaggedError<ReviewPacketDanglingMediaError>()(
  "ReviewPacketDanglingMediaError",
  { mediaIds: Schema.Array(Schema.String), count: Schema.Number },
) {
  override get message(): string {
    return `Evidence points at ${this.count} media ${this.count === 1 ? "id" : "ids"} that media[] does not list: ${this.mediaIds.join(", ")}.`;
  }
}

export class ReviewPacketMediaTypeError extends Schema.TaggedError<ReviewPacketMediaTypeError>()(
  "ReviewPacketMediaTypeError",
  { mediaId: Schema.String, type: Schema.String },
) {
  override get message(): string {
    return `Media ${this.mediaId} has type ${this.type}; T3 Code accepts ${Object.keys(MEDIA_TYPES).join(", ")}.`;
  }
}

export class ReviewPacketMediaPathError extends Schema.TaggedError<ReviewPacketMediaPathError>()(
  "ReviewPacketMediaPathError",
  { mediaId: Schema.String, file: Schema.String },
) {
  override get message(): string {
    return `Media ${this.mediaId} names ${this.file}, which is not a plain path inside the packet folder (no absolute paths, '..', backslashes or symbolic links).`;
  }
}

export class ReviewPacketMediaMissingError extends Schema.TaggedError<ReviewPacketMediaMissingError>()(
  "ReviewPacketMediaMissingError",
  { mediaId: Schema.String, file: Schema.String },
) {
  override get message(): string {
    return `Media ${this.mediaId} names ${this.file}, which is not a regular file in the packet folder.`;
  }
}

export class ReviewPacketMediaSizeError extends Schema.TaggedError<ReviewPacketMediaSizeError>()(
  "ReviewPacketMediaSizeError",
  { mediaId: Schema.String, file: Schema.String, expected: Schema.Number, actual: Schema.Number },
) {
  override get message(): string {
    return `Media ${this.mediaId} (${this.file}) is ${this.actual} bytes; media[] says ${this.expected}.`;
  }
}

export class ReviewPacketMediaHashError extends Schema.TaggedError<ReviewPacketMediaHashError>()(
  "ReviewPacketMediaHashError",
  { mediaId: Schema.String, file: Schema.String, actual: Schema.String },
) {
  override get message(): string {
    return `${this.file} hashes to sha256:${this.actual}, not ${this.mediaId}.`;
  }
}

export class ReviewPacketStoreError extends Schema.TaggedError<ReviewPacketStoreError>()(
  "ReviewPacketStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to store the review packet.";
  }
}

export type ReviewPacketRejection =
  | ReviewPacketFolderError
  | ReviewPacketInvalidError
  | ReviewPacketLimitError
  | ReviewPacketDanglingMediaError
  | ReviewPacketMediaTypeError
  | ReviewPacketMediaPathError
  | ReviewPacketMediaMissingError
  | ReviewPacketMediaSizeError
  | ReviewPacketMediaHashError;

export class ReviewPacketService extends Context.Service<
  ReviewPacketService,
  {
    /** Validates and stores the packet folder at `directory`, on this server's filesystem. */
    readonly submit: (
      input: ReviewPacketSubmitInput,
    ) => Effect.Effect<ReviewPacketSubmitResult, ReviewPacketRejection | ReviewPacketStoreError>;
    readonly list: (
      input: ReviewPacketListInput,
    ) => Effect.Effect<ReviewPacketListResult, ReviewPacketReadError>;
    readonly get: (
      input: ReviewPacketGetInput,
    ) => Effect.Effect<ReviewPacketGetResult, ReviewPacketReadError>;
    /** The type of stored media, for serving it; none when no stored revision lists it. */
    readonly mediaType: (
      mediaId: string,
    ) => Effect.Effect<Option.Option<string>, ReviewPacketReadError>;
  }
>()("t3/review/ReviewPacketService") {}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const decodePacketJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewPacketStrict));
const MAX_ISSUE_LENGTH = 300;

const invalidFromSchemaError = (error: Schema.SchemaError) => {
  const first = formatIssue(error.issue).issues[0];
  const at = (first?.path ?? [])
    .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
    .join(".");
  return new ReviewPacketInvalidError({
    issue: (first?.message ?? "it does not match the format").slice(0, MAX_ISSUE_LENGTH),
    at,
  });
};

/** Checks what the schema cannot: limits, unique claim ids, and that evidence media resolve. */
const checkManifest = Effect.fn("ReviewPacketService.checkManifest")(function* (
  packet: ReviewPacket,
) {
  const limits = REVIEW_PACKET_LIMITS;
  const over = (limit: ReviewPacketLimitError["limit"], actual: number, max: number) =>
    actual > max ? Effect.fail(new ReviewPacketLimitError({ limit, actual, max })) : Effect.void;
  yield* over("claims", packet.claims.length, limits.claims);
  for (const claim of packet.claims) {
    yield* over("evidencePerClaim", claim.evidence.length, limits.evidencePerClaim);
  }
  for (const findings of [packet.blockers, packet.notes]) {
    yield* over("findings", findings.length, limits.findings);
  }
  yield* over("media", packet.media.length, limits.media);
  if (packet.change.repository.trim().split("/").filter(Boolean).length < 2) {
    return yield* new ReviewPacketInvalidError({
      issue: "the repository must be owner/name",
      at: "change.repository",
    });
  }
  if (packet.change.branch.trim() === "") {
    return yield* new ReviewPacketInvalidError({
      issue: "the branch is empty",
      at: "change.branch",
    });
  }
  const claimIds = new Set<string>();
  for (const [index, claim] of packet.claims.entries()) {
    if (claimIds.has(claim.id)) {
      return yield* new ReviewPacketInvalidError({
        issue: `claim id ${claim.id} is used twice`,
        at: `claims.${index}.id`,
      });
    }
    claimIds.add(claim.id);
  }
  const dangling = findDanglingMediaReferences(packet);
  if (dangling.length > 0) {
    return yield* new ReviewPacketDanglingMediaError({
      mediaIds: dangling.slice(0, 5),
      count: dangling.length,
    });
  }
  let total = 0;
  for (const media of packet.media) {
    const kind = MEDIA_TYPES[media.type];
    if (kind === undefined) {
      return yield* new ReviewPacketMediaTypeError({ mediaId: media.id, type: media.type });
    }
    const max = kind === "image" ? limits.imageBytes : limits.videoBytes;
    if (media.bytes > max) {
      return yield* new ReviewPacketLimitError({
        limit: "mediaBytes",
        actual: media.bytes,
        max,
        mediaId: media.id,
      });
    }
    total += media.bytes;
  }
  yield* over("totalMediaBytes", total, limits.totalMediaBytes);
});

const hexOf = (mediaId: string) => mediaId.slice("sha256:".length);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const repository = yield* ReviewPackets.ReviewPacketRepository;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  // One intake at a time, so a revision's media cannot be collected while another reuses it.
  const intake = yield* Semaphore.make(1);

  const storeError = (operation: string) => (cause: unknown) =>
    new ReviewPacketStoreError({ operation, cause });

  const readManifest = Effect.fn("ReviewPacketService.readManifest")(function* (directory: string) {
    const folderError = (cause?: unknown) =>
      new ReviewPacketFolderError({ directory, ...(cause === undefined ? {} : { cause }) });
    const folder = yield* fileSystem.realPath(directory).pipe(Effect.mapError(folderError));
    const manifestPath = path.join(folder, "packet.json");
    const info = yield* fileSystem.stat(manifestPath).pipe(Effect.mapError(folderError));
    if (info.type !== "File") return yield* folderError();
    const size = Number(info.size);
    if (size > REVIEW_PACKET_LIMITS.manifestBytes) {
      return yield* new ReviewPacketLimitError({
        limit: "manifestBytes",
        actual: size,
        max: REVIEW_PACKET_LIMITS.manifestBytes,
      });
    }
    // Bounded, since the file can grow between the stat and the read.
    const chunks = yield* Stream.runCollect(
      fileSystem.stream(manifestPath, { bytesToRead: REVIEW_PACKET_LIMITS.manifestBytes + 1 }),
    ).pipe(Effect.mapError(folderError));
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength > REVIEW_PACKET_LIMITS.manifestBytes) {
      return yield* new ReviewPacketLimitError({
        limit: "manifestBytes",
        actual: bytes.byteLength,
        max: REVIEW_PACKET_LIMITS.manifestBytes,
      });
    }
    const packet = yield* decodePacketJson(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(invalidFromSchemaError),
    );
    return { folder, packet };
  });

  /** Opens `file` only when it is a regular file reached without leaving the folder or a link. */
  const openInside = Effect.fn("ReviewPacketService.openInside")(function* (
    folder: string,
    media: ReviewPacket["media"][number],
  ) {
    const pathError = new ReviewPacketMediaPathError({ mediaId: media.id, file: media.file });
    const missing = new ReviewPacketMediaMissingError({ mediaId: media.id, file: media.file });
    if (
      media.file === "" ||
      media.file.includes("\\") ||
      media.file.includes("\0") ||
      path.isAbsolute(media.file) ||
      media.file.split("/").includes("..")
    ) {
      return yield* pathError;
    }
    const target = path.join(folder, media.file);
    if (!isWithinRoot(path, target, folder) || target === folder) return yield* pathError;
    const canonical = yield* fileSystem.realPath(target).pipe(Effect.mapError(() => missing));
    if (canonical !== target) return yield* pathError;
    const opened = yield* openMediaFile(target).pipe(Effect.mapError(() => missing));
    if (opened === null) return yield* missing;
    return { target, file: opened };
  });

  const mediaPath = (mediaDir: string, mediaId: string) => path.join(mediaDir, hexOf(mediaId));

  /** Checks one listed file's size and hash, copying its bytes to `copyTo` as it reads them. */
  const verifyMedia = Effect.fn("ReviewPacketService.verifyMedia")(function* (
    folder: string,
    media: ReviewPacket["media"][number],
    copyTo?: string,
  ) {
    const { target, file } = yield* openInside(folder, media);
    const sizeError = (actual: number) =>
      new ReviewPacketMediaSizeError({
        mediaId: media.id,
        file: media.file,
        expected: media.bytes,
        actual,
      });
    if (Number(file.info.size) !== media.bytes) return yield* sizeError(Number(file.info.size));
    const { sha256, read } = yield* hashMediaFile({
      path: target,
      file,
      bytes: media.bytes,
      ...(copyTo === undefined ? {} : { copyTo }),
    }).pipe(Effect.mapError(storeError("readMedia")));
    if (read !== media.bytes) return yield* sizeError(read);
    if (`sha256:${sha256}` !== media.id) {
      return yield* new ReviewPacketMediaHashError({
        mediaId: media.id,
        file: media.file,
        actual: sha256,
      });
    }
  }, Effect.scoped);

  /** Verifies every listed file and moves the ones the store lacks into it. */
  const storeMedia = Effect.fn("ReviewPacketService.storeMedia")(function* (
    folder: string,
    packet: ReviewPacket,
    mediaDir: string,
  ) {
    const staged: Array<{ readonly mediaId: string; readonly partPath: string }> = [];
    const seen = new Set<string>();
    let reused = 0;
    const discardStaged = Effect.forEach(
      staged,
      ({ partPath }) => fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );
    yield* Effect.gen(function* () {
      for (const media of packet.media) {
        if (seen.has(media.id)) continue;
        seen.add(media.id);
        const finalPath = mediaPath(mediaDir, media.id);
        if (yield* fileSystem.exists(finalPath).pipe(Effect.mapError(storeError("checkMedia")))) {
          yield* verifyMedia(folder, media);
          reused += 1;
          continue;
        }
        const partPath = `${finalPath}.part`;
        yield* fileSystem
          .remove(partPath, { force: true })
          .pipe(Effect.mapError(storeError("clearStagedMedia")));
        staged.push({ mediaId: media.id, partPath });
        yield* verifyMedia(folder, media, partPath);
      }
      // Only once every file checked out, so a rejected packet adds nothing to the store.
      for (const { mediaId, partPath } of staged) {
        yield* fileSystem
          .rename(partPath, mediaPath(mediaDir, mediaId))
          .pipe(Effect.mapError(storeError("storeMedia")));
      }
    }).pipe(Effect.onError(() => discardStaged));
    return { copied: staged.length, reused };
  });

  const resolveKey = Effect.fn("ReviewPacketService.resolveKey")(function* (
    folder: string,
    packet: ReviewPacket,
  ) {
    const named = packet.change.repository.trim().toLowerCase();
    const identity = yield* identities.resolve(folder);
    const own = ownPullRequestRepositories(identity).find(
      (candidate) => candidate.key.repository === named,
    );
    return {
      host: own?.key.host ?? "",
      repository: own?.key.repository ?? named,
      branch: packet.change.branch.trim(),
    };
  });

  const submit: ReviewPacketService["Service"]["submit"] = Effect.fn("ReviewPacketService.submit")(
    function* (input) {
      const { folder, packet } = yield* readManifest(input.directory);
      yield* checkManifest(packet);
      const key = yield* resolveKey(folder, packet);
      return yield* intake.withPermits(1)(
        Effect.gen(function* () {
          yield* fileSystem
            .makeDirectory(config.reviewMediaDir, { recursive: true })
            .pipe(Effect.mapError(storeError("makeMediaDirectory")));
          const mediaDir = yield* fileSystem
            .realPath(config.reviewMediaDir)
            .pipe(Effect.mapError(storeError("resolveMediaDirectory")));
          const media = yield* storeMedia(folder, packet, mediaDir);
          const receivedAt = DateTime.formatIso(
            DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          );
          const stored = yield* repository
            .put({ key, packet, receivedAt, keepRevisions: REVIEW_PACKET_REVISIONS_PER_CHANGE })
            .pipe(Effect.mapError(storeError("putRevision")));
          // A file left behind here holds verified bytes; a later intake that lists it reuses it.
          yield* Effect.forEach(
            stored.unreferencedMedia,
            (mediaId) =>
              fileSystem.remove(mediaPath(mediaDir, mediaId), { force: true }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Could not delete unreferenced review media.", {
                    mediaId,
                    cause,
                  }),
                ),
              ),
            { discard: true },
          );
          return {
            change: stored.summary,
            replaced: stored.replaced,
            media,
            pruned: { revisions: stored.prunedRevisions, media: stored.unreferencedMedia.length },
          };
        }),
      );
    },
  );

  const readError = (operation: ReviewPacketReadError["operation"]) => (cause: unknown) =>
    new ReviewPacketReadError({ operation, cause });

  const changeKey = (input: ReviewPacketGetInput) => ({
    host: input.host?.toLowerCase() ?? "",
    repository: input.repository.toLowerCase(),
    branch: input.branch,
  });

  return ReviewPacketService.of({
    submit,
    list: Effect.fn("ReviewPacketService.list")(function* (input) {
      const limit = input.limit ?? LIST_DEFAULT_LIMIT;
      const changes = yield* repository
        .listLatest({
          ...(input.host === undefined ? {} : { host: input.host.toLowerCase() }),
          ...(input.repository === undefined ? {} : { repository: input.repository.toLowerCase() }),
          ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
          limit: limit + 1,
        })
        .pipe(Effect.mapError(readError("list")));
      return { changes: changes.slice(0, limit), hasMore: changes.length > limit };
    }),
    get: Effect.fn("ReviewPacketService.get")(
      function* (input) {
        const key = changeKey(input);
        const revisions = yield* repository.revisions(key);
        const head = input.head ?? revisions[0]?.head;
        const packet = head === undefined ? Option.none() : yield* repository.getPacket(key, head);
        return { packet: Option.getOrNull(packet), revisions };
      },
      Effect.mapError(readError("get")),
    ),
    mediaType: Effect.fn("ReviewPacketService.mediaType")(function* (mediaId) {
      return yield* repository.mediaType(mediaId).pipe(Effect.mapError(readError("mediaType")));
    }),
  });
});

export const layer = Layer.effect(ReviewPacketService, make);
