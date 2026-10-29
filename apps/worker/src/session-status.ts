// Read-only live session discovery for agents sharing a worktree. This command
// deliberately returns task and tool metadata, never credentials or messages.
import { DatabaseSync } from "node:sqlite";

const [dbPath, workspaceId, conversationId] = process.argv.slice(2);
if (!dbPath || !workspaceId || !conversationId)
  throw new Error("Usage: session-status.ts <database> <workspace> <conversation>");
const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
try {
  const sessions = db
    .prepare(`SELECT r.id AS runId, c.id AS conversationId, c.provider, c.title, r.summary AS task, r.state, r.started_at AS startedAt, r.ended_at AS endedAt
    FROM runs r JOIN conversations c ON c.id = r.conversation_id
    WHERE r.workspace_id = ? AND c.id != ? AND r.kind = 'agent_turn'
    AND (r.state IN ('starting','running','waiting_for_input','stopping','queued') OR r.ended_at > ?)
    ORDER BY r.created_at DESC LIMIT 30`)
    .all(workspaceId, conversationId, new Date(Date.now() - 15 * 60_000).toISOString());
  const activity = db.prepare(`SELECT kind, status, json_extract(data, '$.tool') AS tool,
    substr(json_extract(data, '$.arguments'), 1, 4000) AS arguments, substr(json_extract(data, '$.command'), 1, 4000) AS command,
    substr(json_extract(data, '$.changes'), 1, 4000) AS changes, updated_at AS updatedAt
    FROM items WHERE run_id = ? AND kind IN ('command','tool_call','file_change') ORDER BY position DESC LIMIT 5`);
  console.log(
    JSON.stringify(
      {
        workspaceId,
        sessions: sessions.map((session) => ({ ...session, recentActivity: activity.all(String(session.runId)) })),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
