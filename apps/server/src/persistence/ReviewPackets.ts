import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ReviewPacket,
  ReviewPacketRevisionSummary,
  ReviewPacketStrict,
  type ReviewPacketChangeSummary,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type ReviewPacketRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** `host` is '' when intake could not resolve the forge; `repository` is lowercased. */
export interface ReviewPacketKey {
  readonly host: string;
  readonly repository: string;
  readonly branch: string;
}

const SummaryRow = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
  pullRequest: Schema.NullOr(Schema.Number),
  ...ReviewPacketRevisionSummary.fields,
  claimsSeen: Schema.Number,
  claimsNotSeen: Schema.Number,
  claimsUntested: Schema.Number,
  blockers: Schema.Number,
});

const toSummary = (row: typeof SummaryRow.Type): ReviewPacketChangeSummary => ({
  host: row.host === "" ? null : row.host,
  repository: row.repository,
  branch: row.branch,
  pullRequest: row.pullRequest,
  head: row.head,
  base: row.base,
  recordedAt: row.recordedAt,
  verdict: row.verdict,
  claims: { seen: row.claimsSeen, notSeen: row.claimsNotSeen, untested: row.claimsUntested },
  blockers: row.blockers,
});

const summaryOf = (key: ReviewPacketKey, packet: ReviewPacket): ReviewPacketChangeSummary => {
  const count = (result: ReviewPacket["claims"][number]["result"]) =>
    packet.claims.filter((claim) => claim.result === result).length;
  return {
    host: key.host === "" ? null : key.host,
    repository: key.repository,
    branch: key.branch,
    pullRequest: packet.change.pullRequest ?? null,
    head: packet.revision.head,
    base: packet.revision.base,
    recordedAt: packet.revision.recordedAt,
    verdict: packet.status.verdict,
    claims: { seen: count("seen"), notSeen: count("not-seen"), untested: count("untested") },
    blockers: packet.blockers.length,
  };
};

const PacketRow = Schema.Struct({ packet: Schema.fromJsonString(ReviewPacket) });
const HeadRow = Schema.Struct({ head: Schema.String });
const MediaRow = Schema.Struct({ mediaId: Schema.String });
const MediaTypeRow = Schema.Struct({ type: Schema.String });

const decodeRows =
  <S extends Schema.Top>(row: S) =>
  <E, R>(statement: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))));

const toError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("ReviewPacket", cause)
    : new PersistenceSqlError({ operation, cause });

export class ReviewPacketRepository extends Context.Service<
  ReviewPacketRepository,
  {
    /**
     * Stores one revision, replacing its manifest if that head is already stored, then drops the
     * change's oldest revisions beyond `keepRevisions`. Returns the media no revision lists now.
     */
    readonly put: (input: {
      readonly key: ReviewPacketKey;
      readonly packet: ReviewPacket;
      readonly receivedAt: string;
      readonly keepRevisions: number;
    }) => Effect.Effect<
      {
        readonly summary: ReviewPacketChangeSummary;
        readonly replaced: boolean;
        readonly prunedRevisions: number;
        readonly unreferencedMedia: ReadonlyArray<string>;
      },
      ReviewPacketRepositoryError
    >;
    /** Each change's latest revision, newest recorded first. */
    readonly listLatest: (filter: {
      readonly host?: string;
      readonly repository?: string;
      readonly pullRequest?: number;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<ReviewPacketChangeSummary>, ReviewPacketRepositoryError>;
    readonly revisions: (
      key: ReviewPacketKey,
    ) => Effect.Effect<ReadonlyArray<ReviewPacketRevisionSummary>, ReviewPacketRepositoryError>;
    readonly getPacket: (
      key: ReviewPacketKey,
      head: string,
    ) => Effect.Effect<Option.Option<ReviewPacket>, ReviewPacketRepositoryError>;
    readonly mediaType: (
      mediaId: string,
    ) => Effect.Effect<Option.Option<string>, ReviewPacketRepositoryError>;
  }
>()("t3/persistence/ReviewPackets/ReviewPacketRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodePacket = Schema.encodeEffect(Schema.fromJsonString(ReviewPacketStrict));

  const summaryColumns = sql`
    host, repository, branch, pull_request AS "pullRequest", head, base,
    recorded_at AS "recordedAt", verdict, claims_seen AS "claimsSeen",
    claims_not_seen AS "claimsNotSeen", claims_untested AS "claimsUntested", blockers
  `;
  const whereKey = (key: ReviewPacketKey) =>
    sql`host = ${key.host} AND repository = ${key.repository} AND branch = ${key.branch}`;

  const newestFirst = sql`ORDER BY recorded_at DESC, received_at DESC`;

  const mediaOf = (key: ReviewPacketKey, head: string) =>
    sql`
      SELECT media_id AS "mediaId" FROM review_packet_media
      WHERE ${whereKey(key)} AND head = ${head}
    `.pipe(
      decodeRows(MediaRow),
      Effect.map((rows) => rows.map((row) => row.mediaId)),
    );

  const dropRevision = (key: ReviewPacketKey, head: string) =>
    Effect.andThen(
      sql`DELETE FROM review_packet_media WHERE ${whereKey(key)} AND head = ${head}`,
      sql`DELETE FROM review_packets WHERE ${whereKey(key)} AND head = ${head}`,
    );

  const put: ReviewPacketRepository["Service"]["put"] = Effect.fn("ReviewPacketRepository.put")(
    function* ({ key, packet, receivedAt, keepRevisions }) {
      const packetJson = yield* encodePacket(packet);
      const summary = summaryOf(key, packet);
      const { head } = summary;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const previousMedia = yield* mediaOf(key, head);
          const existing = yield* sql`
            SELECT 1 FROM review_packets WHERE ${whereKey(key)} AND head = ${head}
          `;
          yield* dropRevision(key, head);
          yield* sql`
            INSERT INTO review_packets (
              host, repository, branch, head, base, pull_request, recorded_at, received_at,
              verdict, claims_seen, claims_not_seen, claims_untested, blockers, packet_json
            ) VALUES (
              ${key.host}, ${key.repository}, ${key.branch}, ${head}, ${summary.base},
              ${summary.pullRequest}, ${summary.recordedAt}, ${receivedAt}, ${summary.verdict},
              ${summary.claims.seen}, ${summary.claims.notSeen}, ${summary.claims.untested},
              ${summary.blockers}, ${packetJson}
            )
          `;
          for (const media of packet.media) {
            yield* sql`
              INSERT OR IGNORE INTO review_packet_media
                (host, repository, branch, head, media_id, type)
              VALUES (${key.host}, ${key.repository}, ${key.branch}, ${head}, ${media.id}, ${media.type})
            `;
          }
          const pruned = yield* sql`
            SELECT head FROM review_packets WHERE ${whereKey(key)} ${newestFirst}
            LIMIT -1 OFFSET ${keepRevisions}
          `.pipe(decodeRows(HeadRow));
          const candidates = new Set(previousMedia);
          for (const row of pruned) {
            for (const mediaId of yield* mediaOf(key, row.head)) candidates.add(mediaId);
            yield* dropRevision(key, row.head);
          }
          if (candidates.size > 0) {
            const stillListed = yield* sql`
              SELECT DISTINCT media_id AS "mediaId" FROM review_packet_media
              WHERE media_id IN ${sql.in([...candidates])}
            `.pipe(decodeRows(MediaRow));
            for (const row of stillListed) candidates.delete(row.mediaId);
          }
          return {
            summary,
            replaced: existing.length > 0,
            prunedRevisions: pruned.length,
            unreferencedMedia: [...candidates],
          };
        }),
      );
    },
    Effect.mapError(toError("putReviewPacket")),
  );

  return ReviewPacketRepository.of({
    put,
    listLatest: Effect.fn("ReviewPacketRepository.listLatest")(
      function* (filter) {
        const host = filter.host ?? null;
        const repository = filter.repository ?? null;
        const pullRequest = filter.pullRequest ?? null;
        const rows = yield* sql`
          SELECT ${summaryColumns} FROM (
            SELECT host, repository, branch, pull_request, head, base, recorded_at, verdict,
              claims_seen, claims_not_seen, claims_untested, blockers, ROW_NUMBER() OVER (
              PARTITION BY host, repository, branch ${newestFirst}
            ) AS position
            FROM review_packets
            WHERE (${host} IS NULL OR host = ${host})
              AND (${repository} IS NULL OR repository = ${repository})
              AND (${pullRequest} IS NULL OR pull_request = ${pullRequest})
          )
          WHERE position = 1
          ORDER BY recorded_at DESC, host, repository, branch
          LIMIT ${filter.limit}
        `.pipe(decodeRows(SummaryRow), NodeSqliteClient.readOnly);
        return rows.map(toSummary);
      },
      Effect.mapError(toError("listReviewPackets")),
    ),
    revisions: Effect.fn("ReviewPacketRepository.revisions")(
      function* (key) {
        return yield* sql`
          SELECT head, base, recorded_at AS "recordedAt", verdict
          FROM review_packets WHERE ${whereKey(key)} ${newestFirst}
        `.pipe(decodeRows(ReviewPacketRevisionSummary), NodeSqliteClient.readOnly);
      },
      Effect.mapError(toError("listReviewPacketRevisions")),
    ),
    getPacket: Effect.fn("ReviewPacketRepository.getPacket")(
      function* (key, head) {
        const rows = yield* sql`
          SELECT packet_json AS "packet" FROM review_packets
          WHERE ${whereKey(key)} AND head = ${head}
        `.pipe(decodeRows(PacketRow), NodeSqliteClient.readOnly);
        return Option.map(Option.fromNullishOr(rows[0]), (row) => row.packet);
      },
      Effect.mapError(toError("getReviewPacket")),
    ),
    mediaType: Effect.fn("ReviewPacketRepository.mediaType")(
      function* (mediaId) {
        const rows = yield* sql`
          SELECT type FROM review_packet_media WHERE media_id = ${mediaId} LIMIT 1
        `.pipe(decodeRows(MediaTypeRow), NodeSqliteClient.readOnly);
        return Option.map(Option.fromNullishOr(rows[0]), (row) => row.type);
      },
      Effect.mapError(toError("getReviewMediaType")),
    ),
  });
});

export const layer = Layer.effect(ReviewPacketRepository, make);
