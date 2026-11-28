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
 * share their parent's checkout and never own it, and a project's coordinator edits nothing.
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
      AND json_extract(payload_json, '$.coordinator') IS NOT 1
    ORDER BY updated_at DESC, thread_id ASC
    LIMIT 50
  `.pipe(NodeSqliteClient.readOnly);
  return yield* decodeBranchThreads(rows);
});

const decodeProjectBranchThreads = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: ThreadId,
      title: Schema.String,
      branch: Schema.String,
      running: Schema.Number,
    }),
  ),
);

/** `listBranchThreads` for many branches of one project at once, with whether each runs a turn. */
export const listProjectBranchThreads = Effect.fn("listProjectBranchThreads")(function* (
  projectId: ProjectId,
  branches: ReadonlyArray<string>,
) {
  if (branches.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT
      t.thread_id AS id,
      t.title,
      json_extract(t.payload_json, '$.branch') AS branch,
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs r
        WHERE r.thread_id = t.thread_id
          AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
      ) AS running
    FROM orchestration_v2_projection_threads t
    WHERE t.project_id = ${projectId}
      AND json_extract(t.payload_json, '$.branch') IN ${sql.in(branches)}
      AND t.deleted_at IS NULL
      AND t.archived_at IS NULL
      AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
      AND json_extract(t.payload_json, '$.coordinator') IS NOT 1
    ORDER BY t.updated_at DESC, t.thread_id ASC
    LIMIT 500
  `.pipe(NodeSqliteClient.readOnly);
  return (yield* decodeProjectBranchThreads(rows)).map((row) => ({
    ...row,
    running: row.running === 1,
  }));
});
