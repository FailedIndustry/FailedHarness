import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A project's own harness cache folder, such as one a harness already filled before T3 Code.
  yield* sql`
    CREATE TABLE IF NOT EXISTS harness_projects (
      project_id TEXT PRIMARY KEY,
      cache_path TEXT NOT NULL
    )
  `;
});
