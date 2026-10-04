// Ordered application events. Every event is persisted before its sequence
// number is published, so `seq` is a durable cursor for reconnect and replay.
import type {
  Command,
  Conversation,
  ConversationItem,
  PendingInput,
  ProcessSession,
  Project,
  Run,
  WorkerStatus,
  Workspace,
} from "./entities.ts";
import type { Artifact, Job } from "./jobs.ts";

export type EventBody =
  | { type: "project.upserted"; project: Project }
  | { type: "workspace.upserted"; workspace: Workspace }
  | { type: "conversation.upserted"; conversation: Conversation }
  | { type: "run.upserted"; run: Run }
  | { type: "input.upserted"; input: PendingInput }
  | { type: "command.upserted"; command: Command }
  | { type: "process.upserted"; process: ProcessSession }
  | { type: "job.upserted"; job: Job }
  | { type: "job.deleted"; jobId: string }
  | { type: "artifact.upserted"; artifact: Artifact }
  | { type: "worker.status"; status: WorkerStatus }
  // Detail events: only delivered to subscribers of the conversation.
  | { type: "item.upserted"; item: ConversationItem }
  | { type: "item.delta"; itemId: string; field: "text" | "output"; delta: string };

export type EventType = EventBody["type"];

export const DETAIL_EVENT_TYPES: readonly EventType[] = ["item.upserted", "item.delta"];

export type AppEvent = EventBody & {
  seq: number;
  conversationId: string | null;
  createdAt: string;
};

/** Sent instead of events when the requested cursor is older than retained history. */
export type ResetSignal = { type: "reset"; reason: string };
