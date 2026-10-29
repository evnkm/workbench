// Queue only within a conversation. Other conversations in the same workspace
// run independently; the database enforces one active turn per conversation.
import { getItem, latestSeq, listActiveRuns, saveItem, updateRun } from "@workbench/db";
import type { WorkerContext } from "./context.ts";

export function conversationBusy(ctx: WorkerContext, conversationId: string) {
  return listActiveRuns(ctx.db).some(
    (run) => run.kind === "agent_turn" && run.conversationId === conversationId && run.state !== "queued",
  );
}

export function claimQueuedTurn(ctx: WorkerContext, conversationId: string): string | null {
  const db = ctx.db;
  return db.tx(() => {
    if (conversationBusy(ctx, conversationId)) return null;
    const next = db.get<{ id: string }>(
      "SELECT id FROM runs WHERE conversation_id = :c AND kind = 'agent_turn' AND state = 'queued' ORDER BY created_at, rowid LIMIT 1",
      { c: conversationId },
    );
    if (!next) return null;
    const row = db.get<{ id: string }>("SELECT id FROM items WHERE run_id = :r AND kind = 'user_message'", {
      r: next.id,
    });
    if (!row) throw new Error(`Queued run ${next.id} has no user message`);
    // Reveal the queued message after the preceding turn's transcript.
    db.run("UPDATE items SET position = :p WHERE id = :id", { p: latestSeq(db) + 1, id: row.id });
    saveItem(db, getItem(db, row.id)!);
    updateRun(db, next.id, { state: "starting" });
    return next.id;
  });
}
