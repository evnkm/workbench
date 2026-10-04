import { type Config, type Database, type Logger, latestSeq } from "@workbench/db";
import type { IpcServer } from "./ipc.ts";
import { KeyedMutex } from "./util.ts";

/** Shared services for worker modules. */
export class WorkerContext {
  readonly locks = new KeyedMutex();
  private ipc: IpcServer | null = null;

  readonly config: Config;
  readonly db: Database;
  readonly log: Logger;
  readonly instanceId: string;

  constructor(config: Config, db: Database, log: Logger, instanceId: string) {
    this.config = config;
    this.db = db;
    this.log = log;
    this.instanceId = instanceId;
  }

  attachIpc(ipc: IpcServer) {
    this.ipc = ipc;
  }

  /** Call after committing events so connected API servers deliver them. */
  published() {
    this.ipc?.notifyEvents(latestSeq(this.db));
  }
}
