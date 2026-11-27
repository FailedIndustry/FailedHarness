// @effect-diagnostics nodeBuiltinImport:off - fixtures name their media by its SHA-256.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ReviewPackets from "../persistence/ReviewPackets.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ReviewPacketService from "./ReviewPacketService.ts";

const layer = ReviewPacketService.layer.pipe(
  Layer.provide(ReviewPackets.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-packets-" })),
  Layer.provideMerge(NodeServices.layer),
);

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const commit = (revision: number) => revision.toString(16).padStart(40, "0");

/** A small file in a packet: its manifest entry and the bytes behind it. */
const mediaFile = (name: string, type: "image/png" | "video/mp4") => {
  const bytes = new TextEncoder().encode(`synthetic ${name}`);
  const hex = sha256(bytes);
  const extension = type === "image/png" ? "png" : "mp4";
  return {
    bytes,
    hex,
    entry: { id: `sha256:${hex}`, file: `media/${hex}.${extension}`, type, bytes: bytes.length },
  };
};
type MediaFile = ReturnType<typeof mediaFile>;

const manifest = (input: {
  readonly head: number;
  readonly recordedAt: string;
  readonly media: ReadonlyArray<MediaFile>;
  readonly branch?: string;
  readonly verdict?: "pass" | "fail";
}) => ({
  schema: 1,
  change: {
    repository: "Acme/App",
    branch: input.branch ?? "trade-in-world",
    base: "main",
    pullRequest: 18,
  },
  revision: { base: commit(1), head: commit(input.head), recordedAt: input.recordedAt },
  status: { verdict: input.verdict ?? "pass" },
  claims: [
    {
      id: "trade-in-world",
      title: "Trade in world",
      statement: "Trading happens beside the vendor.",
      result: "seen",
      evidence: input.media.map((media, index) => ({
        id: `evidence-${index}`,
        kind: "image",
        media: media.entry.id,
      })),
      paths: ["plugins/vendor/"],
    },
    {
      id: "smelt",
      title: "Smelt ores",
      statement: "Ores smelt into bars.",
      result: "untested",
      evidence: [],
      paths: [],
    },
  ],
  blockers: [],
  notes: [{ text: "Recorded on the test map." }],
  media: input.media.map((media) => media.entry),
});

const writePacket = Effect.fn("test.writePacket")(function* (
  directory: string,
  packet: object,
  media: ReadonlyArray<MediaFile>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.join(directory, "media"), { recursive: true });
  for (const file of media) {
    yield* fileSystem.writeFile(path.join(directory, file.entry.file), file.bytes);
  }
  yield* fileSystem.writeFileString(path.join(directory, "packet.json"), JSON.stringify(packet));
  return directory;
});

const storedMedia = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { reviewMediaDir } = yield* ServerConfig.ServerConfig;
  return (yield* fileSystem.exists(reviewMediaDir))
    ? (yield* fileSystem.readDirectory(reviewMediaDir)).toSorted()
    : [];
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.provide(ProcessRunner.layer),
  );

describe("ReviewPacketService", () => {
  it.effect(
    "stores a packet from a checkout under its forge, and replaces it when the revision comes again",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ReviewPacketService.ReviewPacketService;
        const { reviewMediaDir } = yield* ServerConfig.ServerConfig;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-packet-repo-" });
        yield* git(checkout, ["init", "--quiet"]);
        yield* git(checkout, ["remote", "add", "origin", "https://github.com/Acme/App.git"]);
        const shot = mediaFile("shot", "image/png");
        const clip = mediaFile("clip", "video/mp4");
        const directory = path.join(checkout, ".harness", "packet");
        yield* writePacket(
          directory,
          manifest({ head: 2, recordedAt: "2026-11-27T10:00:00Z", media: [shot, clip] }),
          [shot, clip],
        );

        const first = yield* service.submit({ directory });
        expect(first).toEqual({
          change: {
            host: "github.com",
            repository: "acme/app",
            branch: "trade-in-world",
            pullRequest: 18,
            head: commit(2),
            base: commit(1),
            recordedAt: "2026-11-27T10:00:00Z",
            verdict: "pass",
            claims: { seen: 1, notSeen: 0, untested: 1 },
            blockers: 0,
          },
          replaced: false,
          media: { copied: 2, reused: 0 },
          pruned: { revisions: 0, media: 0 },
        });
        expect(yield* storedMedia).toEqual([shot.hex, clip.hex].toSorted());
        expect(
          Buffer.from(yield* fileSystem.readFile(path.join(reviewMediaDir, clip.hex))),
        ).toEqual(Buffer.from(clip.bytes));

        yield* writePacket(
          directory,
          manifest({
            head: 2,
            recordedAt: "2026-11-27T10:00:00Z",
            media: [shot, clip],
            verdict: "fail",
          }),
          [shot, clip],
        );
        const again = yield* service.submit({ directory });
        expect(again.replaced).toBe(true);
        expect(again.media).toEqual({ copied: 0, reused: 2 });

        const other = path.join(checkout, ".harness", "other");
        yield* writePacket(
          other,
          manifest({
            head: 3,
            recordedAt: "2026-11-27T11:00:00Z",
            media: [shot],
            branch: "smelting",
          }),
          [shot],
        );
        yield* service.submit({ directory: other });

        const newest = yield* service.list({ repository: "ACME/app", limit: 1 });
        expect(newest.changes.map((change) => change.branch)).toEqual(["smelting"]);
        expect(newest.hasMore).toBe(true);
        const byPullRequest = yield* service.list({ host: "github.com", pullRequest: 18 });
        expect(byPullRequest.changes.map((change) => change.branch)).toEqual([
          "smelting",
          "trade-in-world",
        ]);
        expect((yield* service.list({ repository: "acme/other" })).changes).toEqual([]);

        const read = yield* service.get({
          host: "github.com",
          repository: "acme/app",
          branch: "trade-in-world",
        });
        expect(read.packet?.status.verdict).toBe("fail");
        expect(read.packet?.claims[0]?.evidence.map((item) => item.id)).toEqual([
          "evidence-0",
          "evidence-1",
        ]);
        expect(read.revisions).toEqual([
          { head: commit(2), base: commit(1), recordedAt: "2026-11-27T10:00:00Z", verdict: "fail" },
        ]);
        expect(yield* service.mediaType(clip.entry.id)).toEqual(Option.some("video/mp4"));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "shares media across revisions, keeps the newest revisions, and deletes media none lists",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ReviewPacketService.ReviewPacketService;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-packet-plain-" });
        const onlyFirst = mediaFile("first revision only", "image/png");
        const shared = mediaFile("unchanged evidence", "video/mp4");
        const submitRevision = (head: number, media: ReadonlyArray<MediaFile>) =>
          writePacket(
            path.join(root, `revision-${head}`),
            manifest({
              head,
              recordedAt: `2026-11-27T10:${String(head).padStart(2, "0")}:00Z`,
              media,
            }),
            media,
          ).pipe(Effect.flatMap((directory) => service.submit({ directory })));

        const first = yield* submitRevision(10, [onlyFirst, shared]);
        // Outside a checkout the forge is unknown; the packet's own name is kept.
        expect([first.change.host, first.change.repository]).toEqual([null, "acme/app"]);
        const second = yield* submitRevision(11, [shared]);
        expect(second.media).toEqual({ copied: 0, reused: 1 });

        const keep = ReviewPacketService.REVIEW_PACKET_REVISIONS_PER_CHANGE;
        let last = second;
        for (let head = 12; head < 10 + keep; head++) last = yield* submitRevision(head, [shared]);
        expect(last.pruned).toEqual({ revisions: 0, media: 0 });
        expect(yield* storedMedia).toEqual([onlyFirst.hex, shared.hex].toSorted());

        const overflow = yield* submitRevision(10 + keep, [shared]);
        expect(overflow.pruned).toEqual({ revisions: 1, media: 1 });
        expect(yield* storedMedia).toEqual([shared.hex]);
        expect(yield* service.mediaType(onlyFirst.entry.id)).toEqual(Option.none());
        const read = yield* service.get({
          host: null,
          repository: "acme/app",
          branch: "trade-in-world",
        });
        expect(read.revisions).toHaveLength(keep);
        expect(read.revisions[0]?.head).toBe(commit(10 + keep));
        expect(read.revisions.some((revision) => revision.head === commit(10))).toBe(false);
        const older = yield* service.get({
          host: null,
          repository: "acme/app",
          branch: "trade-in-world",
          head: commit(11),
        });
        expect(older.packet?.revision.head).toBe(commit(11));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a packet that does not hold up and stores nothing from it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ReviewPacketService.ReviewPacketService;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-packet-bad-" });
      const shot = mediaFile("shot", "image/png");
      const clip = mediaFile("clip", "video/mp4");
      const outside = path.join(root, "outside.png");
      yield* fileSystem.writeFile(outside, shot.bytes);
      const good = () =>
        manifest({ head: 2, recordedAt: "2026-11-27T10:00:00Z", media: [shot, clip] });

      const cases: Array<
        readonly [string, (directory: string) => Effect.Effect<object, PlatformError.PlatformError>]
      > = [
        [
          "ReviewPacketMediaHashError",
          () => {
            const packet = good();
            packet.media[1] = { ...packet.media[1]!, id: `sha256:${"f".repeat(64)}` };
            packet.claims[0]!.evidence[1]!.media = packet.media[1].id;
            return Effect.succeed(packet);
          },
        ],
        [
          "ReviewPacketMediaSizeError",
          () => {
            const packet = good();
            packet.media[0] = { ...packet.media[0]!, bytes: shot.bytes.length + 1 };
            return Effect.succeed(packet);
          },
        ],
        [
          "ReviewPacketMediaPathError",
          () => {
            const packet = good();
            packet.media[0] = { ...packet.media[0]!, file: "../outside.png" };
            return Effect.succeed(packet);
          },
        ],
        [
          "ReviewPacketDanglingMediaError",
          () => {
            const packet = good();
            packet.media.splice(1, 1);
            return Effect.succeed(packet);
          },
        ],
        [
          "ReviewPacketLimitError",
          () =>
            Effect.succeed({
              ...good(),
              summary: "x".repeat(ReviewPacketService.REVIEW_PACKET_LIMITS.manifestBytes),
            }),
        ],
        [
          "ReviewPacketInvalidError",
          () => {
            const packet = good();
            packet.claims[1]!.id = packet.claims[0]!.id;
            return Effect.succeed(packet);
          },
        ],
        ...(symlinksSupported
          ? [
              [
                "ReviewPacketMediaPathError",
                (directory: string) =>
                  fileSystem
                    .makeDirectory(path.join(directory, "linked"), { recursive: true })
                    .pipe(
                      Effect.andThen(
                        fileSystem.symlink(outside, path.join(directory, "linked", "shot.png")),
                      ),
                      Effect.as({
                        ...good(),
                        media: [{ ...shot.entry, file: "linked/shot.png" }, clip.entry],
                      }),
                    ),
              ] as const,
            ]
          : []),
      ];
      for (const [index, [expected, makePacket]] of cases.entries()) {
        const directory = path.join(root, `case-${index}`);
        yield* writePacket(directory, {}, [shot, clip]);
        yield* writePacket(directory, yield* makePacket(directory), []);
        const error = yield* service.submit({ directory }).pipe(Effect.flip);
        expect([index, error._tag]).toEqual([index, expected]);
      }
      expect((yield* service.list({})).changes).toEqual([]);
      expect(yield* storedMedia).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a stored revision whose evidence is of a kind this reader does not know", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ReviewPacketService.ReviewPacketService;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-packet-future-" });
      const shot = mediaFile("shot", "image/png");
      const directory = yield* writePacket(
        root,
        manifest({ head: 2, recordedAt: "2026-11-27T10:00:00Z", media: [shot] }),
        [shot],
      );
      yield* service.submit({ directory });
      // A newer server stored evidence of a kind added after this one shipped.
      yield* sql`
        UPDATE review_packets SET packet_json = json_insert(
          packet_json, '$.claims[0].evidence[#]',
          json_object('id', 'narration', 'kind', 'audio', 'media', ${shot.entry.id})
        )
      `;
      const read = yield* service.get({
        host: null,
        repository: "acme/app",
        branch: "trade-in-world",
      });
      expect(read.packet?.claims[0]?.evidence.map((item) => item.id)).toEqual(["evidence-0"]);
    }).pipe(Effect.provide(layer)),
  );
});
