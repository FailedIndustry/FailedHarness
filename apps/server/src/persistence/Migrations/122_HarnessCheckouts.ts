import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A checkout's harness slot (ports are 5900 + slot), unique among one project's checkouts.
  // `session_id` names a session this server started and has not stopped, so one left running
  // by a crash is stopped at the next start.
  yield* sql`
    CREATE TABLE IF NOT EXISTS harness_checkouts (
      worktree_path TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      session_id TEXT,
      assigned_at TEXT NOT NULL,
      UNIQUE (project_id, slot)
    )
  `;
});
