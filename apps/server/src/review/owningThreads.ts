import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeBranchThreads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: ThreadId, projectId: ProjectId, title: Schema.String })),
);

/**
 * Live threads whose checkout or worktree is on `branch`, most recently active first. Side chats
 * share their parent's checkout and never own it.
 */
export const listBranchThreads = Effect.fn("listBranchThreads")(function* (branch: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT thread_id AS id, project_id AS "projectId", title
    FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.branch') = ${branch}
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND json_extract(payload_json, '$.lineage.sideChat') IS NOT 1
    ORDER BY updated_at DESC, thread_id ASC
    LIMIT 50
  `.pipe(NodeSqliteClient.readOnly);
  return yield* decodeBranchThreads(rows);
});
