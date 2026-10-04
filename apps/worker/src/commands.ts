import {
  type Command,
  type CommandPayload,
  type CommandType,
  commandSchemas,
  parseCommandPayload,
} from "@workbench/contracts";
import { claimCommand, failOrphanedCommands, finishCommand } from "@workbench/db";
import type { WorkerContext } from "./context.ts";

/** A user-facing failure: its message is shown in the browser as is. */
export class CommandError extends Error {}

export type Handler<T extends CommandType> = {
  /** Commands sharing a key execute one at a time, in acceptance order. */
  key: (payload: CommandPayload<T>) => string;
  run: (payload: CommandPayload<T>, command: Command) => Promise<unknown>;
};

export type Handlers = { [T in CommandType]?: Handler<T> };

/**
 * Claims accepted commands and executes them. Claiming is a single UPDATE, so
 * two loops can never execute the same command. Woken by IPC, with a poll as a
 * fallback so a missed wake-up only adds latency.
 */
export class CommandLoop {
  private handlers: Handlers = {};
  private draining = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Set<Promise<unknown>>();

  private readonly ctx: WorkerContext;

  constructor(ctx: WorkerContext) {
    this.ctx = ctx;
  }

  register(handlers: Handlers) {
    Object.assign(this.handlers, handlers);
  }

  start() {
    const orphaned = failOrphanedCommands(this.ctx.db, this.ctx.instanceId);
    if (orphaned.length) this.ctx.log.warn("failed commands orphaned by a previous worker", { count: orphaned.length });
    this.ctx.published();
    this.timer = setInterval(() => this.wake(), 1000);
    this.wake();
  }

  wake() {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        for (
          let c = claimCommand(this.ctx.db, this.ctx.instanceId);
          c;
          c = claimCommand(this.ctx.db, this.ctx.instanceId)
        ) {
          this.dispatch(c);
        }
      } while (this.again);
    } finally {
      this.draining = false;
    }
  }

  private dispatch(command: Command) {
    const type = command.type as CommandType;
    const handler = this.handlers[type] as Handler<CommandType> | undefined;
    const finish = (outcome: { result?: unknown; error?: string }) => {
      finishCommand(this.ctx.db, command.id, outcome);
      this.ctx.published();
    };
    if (!handler || !(type in commandSchemas)) {
      finish({ error: `Unsupported command: ${command.type}` });
      return;
    }
    let payload: CommandPayload<CommandType>;
    try {
      payload = parseCommandPayload(type, command.payload);
    } catch (e) {
      finish({ error: `Invalid command payload: ${(e as Error).message}` });
      return;
    }
    const p = this.ctx.locks
      .run(`cmd:${handler.key(payload)}`, () => handler.run(payload, command))
      .then(
        (result) => finish({ result: result ?? null }),
        (e: Error) => {
          if (!(e instanceof CommandError)) this.ctx.log.error("command failed", { type, id: command.id, err: e });
          finish({ error: e.message });
        },
      );
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }
}
