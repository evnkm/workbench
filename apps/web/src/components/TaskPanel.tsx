// Claude's running subagents, background shells, and monitors, placed above the
// composer like the terminal's task list. The transcript keeps each task's card.
import type { AgentTask, ConversationItem } from "@workbench/contracts";
import { Activity, Bot, Layers, Square, SquareTerminal, Workflow } from "lucide-react";
import { useState } from "react";
import { sendCommand } from "../lib/api.ts";
import { Button, StatusIndicator } from "./ui.tsx";

const KINDS: Record<string, { label: string; Icon: typeof Bot }> = {
  local_agent: { label: "Subagent", Icon: Bot },
  local_bash: { label: "Shell", Icon: SquareTerminal },
  monitor: { label: "Monitor", Icon: Activity },
  local_workflow: { label: "Workflow", Icon: Workflow },
};

export function taskKind(task: AgentTask) {
  return KINDS[task.type ?? ""] ?? { label: "Task", Icon: Layers };
}

/** Tool uses, tokens, and duration, when the provider reports them. */
export function taskUsage(task: AgentTask) {
  const u = task.usage;
  if (!u) return null;
  return [
    u.toolUses ? `${u.toolUses} tool ${u.toolUses === 1 ? "use" : "uses"}` : null,
    u.totalTokens ? `${(u.totalTokens / 1000).toFixed(1)}k tokens` : null,
    `${Math.round(u.durationMs / 1000)}s`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TaskPanel({ items }: { items: ConversationItem[] }) {
  return (
    <div className="shrink-0 border-t border-wb-border px-3 py-2 md:px-6">
      <div className="mx-auto max-h-[30dvh] max-w-3xl overflow-y-auto">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          {items.length} running {items.length === 1 ? "task" : "tasks"}
        </p>
        <ul className="space-y-1">
          {items.map((item) => (
            <TaskRow key={item.id} item={item} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function TaskRow({ item }: { item: ConversationItem }) {
  const task = item.data.task!;
  const { label, Icon } = taskKind(task);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      await sendCommand("task.stop", { conversationId: item.conversationId, runId: item.runId!, taskId: task.id });
    } catch (e) {
      setError((e as Error).message);
      setStopping(false);
    }
  };
  const detail = task.summary ?? (task.lastTool ? `Using ${task.lastTool}` : null);
  return (
    <li className="flex min-h-9 items-center gap-2 text-[13px]">
      <StatusIndicator state="running" />
      <Icon size={13} className="shrink-0 text-neutral-500" aria-label={label} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-neutral-200">{task.description}</span>
        {detail && <span className="text-neutral-500"> · {detail}</span>}
        {error && <span className="text-red-400"> · {error}</span>}
      </span>
      {taskUsage(task) && (
        <span className="hidden shrink-0 text-[11px] text-neutral-500 sm:inline">{taskUsage(task)}</span>
      )}
      <Button size="xs" onClick={() => void stop()} disabled={stopping} aria-label={`Stop ${task.description}`}>
        <Square size={11} /> {stopping ? "Stopping…" : "Stop"}
      </Button>
    </li>
  );
}
