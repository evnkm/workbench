// Reconnecting IPC client to the worker. Only wake-ups and notifications
// cross this link; if it is down, commands still persist and the worker's
// poll picks them up, and event streams fall back to polling the database.
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { ServerToWorker, WorkerToServer } from "@workbench/contracts";
import type { Logger } from "@workbench/db";

export class WorkerLink extends EventEmitter<{ events: [seq: number] }> {
  private socket: Socket | null = null;
  private closed = false;
  connected = false;
  instanceId: string | null = null;
  private readonly path: string;
  private readonly log: Logger;

  constructor(path: string, log: Logger) {
    super();
    this.setMaxListeners(0);
    this.path = path;
    this.log = log;
  }

  start() {
    if (this.closed) return;
    const socket = connect(this.path);
    this.socket = socket;
    socket.on("connect", () => {
      this.connected = true;
      this.log.info("connected to worker");
      this.send({ type: "ping", id: 1 });
    });
    const lines = createInterface({ input: socket });
    // The socket's errors (for example a stale socket file after a worker crash)
    // are re-emitted here; without a handler they would crash the API server.
    lines.on("error", () => {});
    lines.on("line", (line) => {
      let msg: WorkerToServer;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "events") this.emit("events", msg.seq);
      if (msg.type === "pong") this.instanceId = msg.instanceId;
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.connected) this.log.warn("worker connection lost");
      this.connected = false;
      this.socket = null;
      if (!this.closed) setTimeout(() => this.start(), 1000);
    });
  }

  private send(msg: ServerToWorker) {
    if (this.connected && this.socket) this.socket.write(`${JSON.stringify(msg)}\n`);
  }

  wake() {
    this.send({ type: "wake" });
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}
