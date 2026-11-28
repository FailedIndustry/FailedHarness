import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per stored revision of a change. `host` is '' when intake could not resolve the
  // forge. The counts let a feed rank changes without decoding manifests.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_packets (
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      head TEXT NOT NULL,
      base TEXT NOT NULL,
      pull_request INTEGER,
      recorded_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      verdict TEXT NOT NULL,
      claims_seen INTEGER NOT NULL,
      claims_not_seen INTEGER NOT NULL,
      claims_untested INTEGER NOT NULL,
      blockers INTEGER NOT NULL,
      packet_json TEXT NOT NULL,
      PRIMARY KEY (host, repository, branch, head)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS review_packets_by_recorded
    ON review_packets (host, repository, branch, recorded_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS review_packets_by_pull_request
    ON review_packets (host, repository, pull_request)
    WHERE pull_request IS NOT NULL
  `;
  // The media each stored revision lists, so unreferenced files can be found by hash.
  yield* sql`
    CREATE TABLE IF NOT EXISTS review_packet_media (
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL,
      head TEXT NOT NULL,
      media_id TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (host, repository, branch, head, media_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS review_packet_media_by_id ON review_packet_media (media_id)
  `;
});
