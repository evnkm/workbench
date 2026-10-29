import { type Conversation, type ConversationItem, nowIso, uuidv7 } from "@workbench/contracts";
import { listItems, saveConversation, saveItem } from "@workbench/db";
import type { WorkerContext } from "./context.ts";

/** Copy a conversation and its history onto a provider's forked thread. */
export function saveFork(
  ctx: WorkerContext,
  conv: Conversation,
  patch: Pick<Conversation, "providerThreadId" | "model">,
) {
  const db = ctx.db;
  const now = nowIso();
  const id = uuidv7();
  db.tx(() => {
    saveConversation(db, {
      ...conv,
      ...patch,
      id,
      title: `Fork of ${conv.title}`.slice(0, 200),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
    const items: ConversationItem[] = [];
    let before: number | null = null;
    for (;;) {
      const page = listItems(db, conv.id, before, 200);
      items.unshift(...page.items);
      if (!page.hasMore) break;
      before = page.items[0]!.position;
    }
    for (const item of items)
      saveItem(db, { ...item, id: uuidv7(), conversationId: id, runId: null, position: undefined });
  });
  ctx.published();
  return { conversationId: id };
}
