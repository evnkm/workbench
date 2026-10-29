// Route durable commands by their conversation owner. Message queues are per
// conversation; independent conversations can share a worktree.
import type { CommandType, Provider } from "@workbench/contracts";
import { getConversation, getInput } from "@workbench/db";
import type { ClaudeProvider } from "./claude/provider.ts";
import type { CodexProvider } from "./codex/provider.ts";
import { CommandError, type Handler, type Handlers } from "./commands.ts";
import type { WorkerContext } from "./context.ts";

export function agentHandlers(ctx: WorkerContext, codex: CodexProvider, claude: ClaudeProvider): Handlers {
  const handlers = codex.handlers();
  const owner = (id: string): Provider => {
    const conv = getConversation(ctx.db, id);
    if (!conv) throw new CommandError("Conversation not found.");
    return conv.provider;
  };
  const route = <T extends CommandType>(
    type: T,
    provider: (p: Parameters<Handler<T>["run"]>[0]) => Provider,
    run: Handler<T>["run"],
  ) => {
    const original = handlers[type]!;
    const handler: Handler<T> = {
      key: original.key,
      run: (p, command) => (provider(p) === "claude" ? run(p, command) : original.run(p, command)),
    };
    // Keep the command/payload correlation at this generic assignment boundary.
    Object.assign(handlers, { [type]: handler });
  };
  route(
    "conversation.create",
    (p) => p.provider,
    (p) => claude.createConversation(p),
  );
  route(
    "conversation.delete",
    (p) => getConversation(ctx.db, p.conversationId)?.provider ?? "codex",
    (p) => claude.deleteConversation(p),
  );
  route(
    "conversation.configure",
    (p) => owner(p.conversationId),
    (p) => claude.configureConversation(p),
  );
  route(
    "turn.start",
    (p) => owner(p.conversationId),
    (p) => claude.submitTurn(p),
  );
  route(
    "turn.interrupt",
    (p) => owner(p.conversationId),
    (p) => claude.interrupt(p),
  );
  handlers["task.stop"] = {
    key: (p) => `conversation:${p.conversationId}`,
    run: async (p) => {
      if (owner(p.conversationId) !== "claude")
        throw new CommandError("Stopping a task is available for Claude conversations only.");
      return claude.stopTask(p);
    },
  };
  route(
    "input.respond",
    (p) => {
      const input = getInput(ctx.db, p.inputId);
      if (!input) throw new CommandError("Request not found.");
      return owner(input.conversationId);
    },
    (p) => claude.respond(p),
  );
  route(
    "conversation.inspect",
    (p) => owner(p.conversationId),
    (p) => claude.inspect(p),
  );
  route(
    "conversation.action",
    (p) => owner(p.conversationId),
    (p) => claude.conversationAction(p),
  );
  return handlers;
}
