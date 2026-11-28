import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Review comments live by change, not in the bounded event log, so they outlive revisions and
  // replay windows. `state` and `unsent` are derived from the entries on every write, so a feed
  // counts them without reading entries.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_comments (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      anchor_json TEXT NOT NULL,
      state TEXT NOT NULL,
      unsent INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS review_comments_by_change
    ON review_comments (host, repository, branch, created_at, id)
  `;
  // `thread_id` is the thread a person's entry was sent to, or the thread whose agent answered.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_comment_entries (
      comment_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      id TEXT NOT NULL,
      author TEXT NOT NULL,
      kind TEXT,
      text TEXT NOT NULL,
      fixed_in TEXT,
      thread_id TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      PRIMARY KEY (comment_id, ordinal)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS review_comment_entries_by_thread
    ON review_comment_entries (thread_id) WHERE thread_id IS NOT NULL
  `;
});
