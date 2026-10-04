import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { ServerToWorker, WorkerToServer } from "@workbench/contracts";
import type { Logger } from "@workbench/db";

/** Unix-socket IPC endpoint for the API server (see contracts/ipc.ts). */
export class IpcServer {
  private clients = new Set<Socket>();
  private server = createServer((socket) => this.accept(socket));
  private lastSeq = 0;
  private pendingSeq: number | null = null;

  private readonly path: string;
  private readonly instanceId: string;
  private readonly onWake: () => void;
  private readonly log: Logger;

  constructor(path: string, instanceId: string, onWake: () => void, log: Logger) {
    this.path = path;
    this.instanceId = instanceId;
    this.onWake = onWake;
    this.log = log;
  }

  listen(): Promise<void> {
    rmSync(this.path, { force: true });
    return new Promise((resolve) => {
      this.server.listen(this.path, () => {
        chmodSync(this.path, 0o600);
        resolve();
      });
    });
  }

  private accept(socket: Socket) {
    this.clients.add(socket);
    this.log.info("ipc client connected", { clients: this.clients.size });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on("error", () => {});
    lines.on("line", (line) => {
      let msg: ServerToWorker;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "wake") this.onWake();
      if (msg.type === "ping") this.send(socket, { type: "pong", id: msg.id, instanceId: this.instanceId });
    });
    if (this.lastSeq) this.send(socket, { type: "events", seq: this.lastSeq });
  }

  private send(socket: Socket, msg: WorkerToServer) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
  }

  /** Coalesce notifications: at most one message per tick with the latest seq. */
  notifyEvents(seq: number) {
    if (seq <= this.lastSeq) return;
    const scheduled = this.pendingSeq !== null;
    this.pendingSeq = seq;
    if (scheduled) return;
    setImmediate(() => {
      const s = this.pendingSeq!;
      this.pendingSeq = null;
      this.lastSeq = Math.max(this.lastSeq, s);
      for (const c of this.clients) this.send(c, { type: "events", seq: this.lastSeq });
    });
  }

  close(): Promise<void> {
    for (const c of this.clients) c.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
