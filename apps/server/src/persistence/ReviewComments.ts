import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ReviewCommentAnchor,
  ReviewCommentAnchorInput,
  ReviewCommentAnswerKind,
  ReviewCommentState,
  ThreadId,
  type ReviewCommentCounts,
} from "@t3tools/contracts";

import {
  deriveReviewCommentState,
  sendableEntries,
  type StoredReviewComment,
  type StoredReviewCommentEntry,
} from "../review/reviewCommentModel.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";
import type { ReviewPacketKey } from "./ReviewPackets.ts";

export type ReviewCommentRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const CommentRow = Schema.Struct({
  position: Schema.Number,
  id: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
  anchor: Schema.fromJsonString(ReviewCommentAnchor),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});

const EntryRow = Schema.Struct({
  commentId: Schema.String,
  id: Schema.String,
  author: Schema.Literals(["person", "agent"]),
  kind: Schema.NullOr(ReviewCommentAnswerKind),
  text: Schema.String,
  fixedIn: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  sentAt: Schema.NullOr(Schema.String),
});

const CountRow = Schema.Struct({
  state: ReviewCommentState,
  comments: Schema.Number,
  unsent: Schema.Number,
});
const KeyRow = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  branch: Schema.String,
});

const decodeRows =
  <S extends Schema.Top>(row: S) =>
  <E, R>(statement: Effect.Effect<ReadonlyArray<unknown>, E, R>) =>
    statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(row))));

const toError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError("ReviewComment", cause)
    : new PersistenceSqlError({ operation, cause });

const toEntry = (row: typeof EntryRow.Type): StoredReviewCommentEntry =>
  row.author === "person"
    ? {
        id: row.id,
        author: "person",
        text: row.text,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        sentAt: row.sentAt,
        sentToThreadId: row.threadId,
        messageId: row.messageId,
      }
    : {
        id: row.id,
        author: "agent",
        kind: row.kind ?? "answered",
        text: row.text,
        fixedIn: row.fixedIn,
        threadId: row.threadId,
        createdAt: row.createdAt,
      };

export class ReviewCommentRepository extends Context.Service<
  ReviewCommentRepository,
  {
    /** Stores a new comment with its entries; only a new comment's anchor is written. */
    readonly insert: (
      comment: StoredReviewComment & { readonly anchor: ReviewCommentAnchorInput },
    ) => Effect.Effect<void, ReviewCommentRepositoryError>;
    /** Replaces a stored comment's entries and resolution. */
    readonly update: (
      comment: StoredReviewComment,
    ) => Effect.Effect<void, ReviewCommentRepositoryError>;
    readonly remove: (commentId: string) => Effect.Effect<void, ReviewCommentRepositoryError>;
    readonly get: (
      commentId: string,
    ) => Effect.Effect<Option.Option<StoredReviewComment>, ReviewCommentRepositoryError>;
    /** In creation order, after the comment at `after` when given. */
    readonly list: (
      key: ReviewPacketKey,
      options: {
        readonly states?: ReadonlyArray<ReviewCommentState>;
        readonly after?: number;
        readonly limit?: number;
        readonly withUnsent?: boolean;
      },
    ) => Effect.Effect<ReadonlyArray<StoredReviewComment>, ReviewCommentRepositoryError>;
    readonly counts: (
      key: ReviewPacketKey,
    ) => Effect.Effect<ReviewCommentCounts, ReviewCommentRepositoryError>;
    /** The changes with an entry sent to, or answered from, this thread. */
    readonly changesOfThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ReviewPacketKey>, ReviewCommentRepositoryError>;
  }
>()("t3/persistence/ReviewComments/ReviewCommentRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeAnchor = Schema.encodeEffect(Schema.fromJsonString(ReviewCommentAnchorInput));
  const whereKey = (key: ReviewPacketKey) =>
    sql`host = ${key.host} AND repository = ${key.repository} AND branch = ${key.branch}`;

  const writeEntries = Effect.fn("ReviewCommentRepository.writeEntries")(function* (
    comment: StoredReviewComment,
  ) {
    yield* sql`DELETE FROM review_comment_entries WHERE comment_id = ${comment.id}`;
    for (const [ordinal, entry] of comment.entries.entries()) {
      const person = entry.author === "person" ? entry : null;
      const agent = entry.author === "agent" ? entry : null;
      yield* sql`
          INSERT INTO review_comment_entries (
            comment_id, ordinal, id, author, kind, text, fixed_in, thread_id, message_id,
            created_at, updated_at, sent_at
          ) VALUES (
            ${comment.id}, ${ordinal}, ${entry.id}, ${entry.author}, ${agent?.kind ?? null},
            ${entry.text}, ${agent?.fixedIn ?? null},
            ${person?.sentToThreadId ?? agent?.threadId ?? null}, ${person?.messageId ?? null},
            ${entry.createdAt}, ${person?.updatedAt ?? entry.createdAt}, ${person?.sentAt ?? null}
          )
        `;
    }
  });

  const derived = (comment: StoredReviewComment) => ({
    state: deriveReviewCommentState(comment),
    unsent: sendableEntries(comment).length,
  });

  const withEntries = Effect.fn("ReviewCommentRepository.withEntries")(function* (
    rows: ReadonlyArray<typeof CommentRow.Type>,
  ) {
    if (rows.length === 0) return [];
    const entries = yield* sql`
        SELECT comment_id AS "commentId", id, author, kind, text, fixed_in AS "fixedIn",
          thread_id AS "threadId", message_id AS "messageId", created_at AS "createdAt",
          updated_at AS "updatedAt", sent_at AS "sentAt"
        FROM review_comment_entries
        WHERE comment_id IN ${sql.in(rows.map((row) => row.id))}
        ORDER BY comment_id, ordinal
      `.pipe(decodeRows(EntryRow));
    const byComment = Map.groupBy(entries, (entry) => entry.commentId);
    return rows.map(({ position, ...row }): StoredReviewComment => ({
      ...row,
      position,
      entries: (byComment.get(row.id) ?? []).map(toEntry),
    }));
  });

  const commentColumns = sql`
    rowid AS "position", id, host, repository, branch, anchor_json AS "anchor", created_at AS "createdAt",
    updated_at AS "updatedAt", resolved_at AS "resolvedAt"
  `;

  return ReviewCommentRepository.of({
    insert: Effect.fn("ReviewCommentRepository.insert")(
      function* (comment) {
        const anchorJson = yield* encodeAnchor(comment.anchor);
        const { state, unsent } = derived(comment);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO review_comments (
                id, host, repository, branch, anchor_json, state, unsent, created_at, updated_at,
                resolved_at
              ) VALUES (
                ${comment.id}, ${comment.host}, ${comment.repository}, ${comment.branch},
                ${anchorJson}, ${state}, ${unsent}, ${comment.createdAt}, ${comment.updatedAt},
                ${comment.resolvedAt}
              )
            `;
            yield* writeEntries(comment);
          }),
        );
      },
      Effect.mapError(toError("insertReviewComment")),
    ),
    update: Effect.fn("ReviewCommentRepository.update")(
      function* (comment) {
        const { state, unsent } = derived(comment);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE review_comments SET state = ${state}, unsent = ${unsent},
                updated_at = ${comment.updatedAt}, resolved_at = ${comment.resolvedAt}
              WHERE id = ${comment.id}
            `;
            yield* writeEntries(comment);
          }),
        );
      },
      Effect.mapError(toError("updateReviewComment")),
    ),
    remove: Effect.fn("ReviewCommentRepository.remove")(
      function* (commentId) {
        yield* sql.withTransaction(
          Effect.andThen(
            sql`DELETE FROM review_comment_entries WHERE comment_id = ${commentId}`,
            sql`DELETE FROM review_comments WHERE id = ${commentId}`,
          ),
        );
      },
      Effect.mapError(toError("removeReviewComment")),
    ),
    get: Effect.fn("ReviewCommentRepository.get")(
      function* (commentId) {
        const rows =
          yield* sql`SELECT ${commentColumns} FROM review_comments WHERE id = ${commentId}`.pipe(
            decodeRows(CommentRow),
            NodeSqliteClient.readOnly,
          );
        return Option.fromNullishOr((yield* withEntries(rows))[0]);
      },
      Effect.mapError(toError("getReviewComment")),
    ),
    list: Effect.fn("ReviewCommentRepository.list")(
      function* (key, options) {
        const states = options.states ?? [];
        const rows = yield* sql`
          SELECT ${commentColumns} FROM review_comments
          WHERE ${whereKey(key)}
            ${states.length === 0 ? sql`` : sql`AND state IN ${sql.in(states)}`}
            ${options.withUnsent === true ? sql`AND unsent > 0` : sql``}
            ${options.after === undefined ? sql`` : sql`AND rowid > ${options.after}`}
          ORDER BY rowid
          ${options.limit === undefined ? sql`` : sql`LIMIT ${options.limit}`}
        `.pipe(decodeRows(CommentRow), NodeSqliteClient.readOnly);
        return yield* withEntries(rows);
      },
      Effect.mapError(toError("listReviewComments")),
    ),
    counts: Effect.fn("ReviewCommentRepository.counts")(
      function* (key) {
        const rows = yield* sql`
          SELECT state, COUNT(*) AS comments, SUM(unsent) AS unsent FROM review_comments
          WHERE ${whereKey(key)} GROUP BY state
        `.pipe(decodeRows(CountRow), NodeSqliteClient.readOnly);
        const counts = { pending: 0, open: 0, answered: 0, resolved: 0, unsent: 0 };
        for (const row of rows) {
          counts[row.state] = row.comments;
          counts.unsent += row.unsent;
        }
        return counts;
      },
      Effect.mapError(toError("countReviewComments")),
    ),
    changesOfThread: Effect.fn("ReviewCommentRepository.changesOfThread")(
      function* (threadId) {
        return yield* sql`
          SELECT DISTINCT c.host, c.repository, c.branch
          FROM review_comment_entries AS e JOIN review_comments AS c ON c.id = e.comment_id
          WHERE e.thread_id = ${threadId}
        `.pipe(decodeRows(KeyRow), NodeSqliteClient.readOnly);
      },
      Effect.mapError(toError("listReviewCommentChangesOfThread")),
    ),
  });
});

export const layer = Layer.effect(ReviewCommentRepository, make);
